"""SOS emergency engine.

Lifecycle (server-authoritative):

``ARMING`` -> ``COUNTDOWN`` -> ``ACTIVE`` -> ``ESCALATING`` -> ``RESOLVED``
with ``CANCELLED`` reachable from COUNTDOWN (before contact) and from ACTIVE
(after contact, which is always recorded as such).

Design guarantees
-----------------
* **Deterministic.** No AI, no external dependency, no async job. A single
  ``POST`` produces the incident row, the anchor location, the share token and
  the notification attempts, or an explicit error.
* **Duplicate-safe.** An existing open incident is returned as
  ``409 duplicate_suppressed`` with the original reference, so a double-tap or a
  reconnect can never create two emergencies or double-alert everyone.
* **Honest.** No endpoint here claims police were contacted. There is no police
  integration; the product tells the user to press Call 112.
* **Auditable.** Every transition is appended to ``incident_events``.
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, current_app, request

from .. import repo, validation
from ..errors import ConflictError, NotFoundError, ServiceUnavailableError, ValidationError
from ..logging_utils import audit, human_reference, iso, log_event, utcnow
from ..notifications import DeliveryResult, build_emergency_message, build_safe_message
from ..security import login_required, new_token, hash_token, rate_limit
from ..validation import require_json
from .helpers import (
    db_path,
    ok,
    serialize_incident,
    public_user,
)

bp = Blueprint("sos", __name__, url_prefix="/api/sos")

OPEN_STATES = ("ARMING", "COUNTDOWN", "ACTIVE", "ESCALATING")

LIFECYCLE_DOC = {
    "states": ["IDLE", "ARMING", "COUNTDOWN", "ACTIVE", "ESCALATING", "RESOLVED", "CANCELLED"],
    "openStates": list(OPEN_STATES),
    "transitions": {
        "ARMING": ["COUNTDOWN", "ACTIVE", "CANCELLED"],
        "COUNTDOWN": ["ACTIVE", "CANCELLED"],
        "ACTIVE": ["ESCALATING", "RESOLVED", "CANCELLED"],
        "ESCALATING": ["RESOLVED"],
        "RESOLVED": [],
        "CANCELLED": [],
    },
    "guarantees": [
        "SOS is deterministic and never depends on an AI service or any external API.",
        "At most one incident may be open per account.",
        "Every transition is recorded with actor and timestamp.",
        "No endpoint in SheSafe contacts police; Call 112 is a user-initiated dialler action.",
    ],
}


# ------------------------------------------------------------------- arming


@bp.get("/lifecycle")
@rate_limit("read")
def lifecycle():
    return ok({"lifecycle": LIFECYCLE_DOC})


@bp.post("/arm")
@rate_limit("sos")
@login_required
def arm():
    """Create an incident in ARMING and return the countdown window.

    Idempotent by design: if an incident is already open the existing one is
    returned and **no** new contacts are alerted.
    """
    user = _user()
    dbp = db_path()
    existing = repo.find_active_incident(dbp, user["id"])
    if existing:
        raise ConflictError(
            f"An emergency is already open (reference {existing['reference']}).",
            code="duplicate_suppressed",
            reference=existing["reference"],
            incidentId=existing["id"],
            state=existing["state"],
        )

    body = request.get_json(silent=True) or {}
    source = validation.enum_field(
        {"trigger_source": body.get("triggerSource", "button")},
        "trigger_source",
        {"button", "voice", "journey", "api"},
        label="Trigger source",
    )
    incident = repo.create_incident(
        dbp, user["id"], reference=human_reference("SS"), trigger_source=source or "button", state="ARMING"
    )
    repo.transition_incident(
        dbp,
        incident["id"],
        "COUNTDOWN",
        from_state="ARMING",
        detail=f"cancel window {current_app.config['SOS_CANCEL_GRACE_SECONDS']}s",
    )
    incident = repo.get_incident(dbp, user["id"], incident["id"])  # type: ignore[assignment]
    audit(
        dbp,
        action="sos.arm",
        outcome="success",
        actor_id=user["id"],
        actor_label=user.get("name"),
        target_type="incident",
        target_id=incident["id"],
        detail={"reference": incident["reference"], "trigger": source},
        **audit_meta(),
    )
    log_event("sos.armed", request_id=request_id(), user_id=user["id"], reference=incident["reference"])
    return ok(
        {
            "incident": serialize_incident(incident, dbp=dbp),
            "cancelWindowSeconds": current_app.config["SOS_CANCEL_GRACE_SECONDS"],
            "next": "POST /api/sos/activate to dispatch",
        },
        201,
    )


# ---------------------------------------------------------------- activation


@bp.post("/activate")
@rate_limit("sos")
@login_required
def activate():
    """Move to ACTIVE: capture location, notify contacts, mint a share token."""
    user = _user()
    dbp = db_path()
    incident = _open_incident(user)

    # Duplicate-suppression: a retry (double tap, flaky network, re-send) must
    # never re-alert every contact. Return the existing incident untouched.
    if incident["state"] in {"ACTIVE", "ESCALATING"}:
        return ok(
            {
                "incident": serialize_incident(incident, dbp=dbp),
                "alreadyActive": True,
                "duplicateSuppressed": True,
                "notificationSummary": serialize_incident(incident, include_events=False, dbp=dbp)["notificationSummary"],
                "note": "This incident was already activated. No further contacts were alerted.",
            }
        )

    body = require_json(request)

    lat = validation.lat_field(body, "lat", required=False)
    lng = validation.lng_field(body, "lng", required=False)
    accuracy = validation.accuracy_field(body, "accuracy")
    speed = _optional_number(body, "speed", lo=0, hi=120)
    heading = _optional_number(body, "heading", lo=0, hi=360)
    battery = validation.int_field(body, "battery", required=False, minimum=0, maximum=100)
    place_label = validation.optional_text(body, "placeLabel", max_length=200)
    source = "gps" if lat is not None else "unavailable"

    repo.record_location_sample(
        dbp,
        user["id"],
        lat=lat if lat is not None else 0.0,
        lng=lng if lng is not None else 0.0,
        accuracy=accuracy,
        speed=speed,
        heading=heading,
        battery=battery,
        incident_id=incident["id"] if lat is not None else None,
        source=source,
    ) if lat is not None else None

    if lat is not None and lng is not None:
        repo.record_incident_location(dbp, incident["id"], lat, lng, accuracy, source)

    repo.transition_incident(
        dbp,
        incident["id"],
        "ACTIVE",
        from_state=incident["state"],
        detail=(
            f"anchor captured (±{int(accuracy)}m)" if lat is not None else "activated without coordinates"
        ),
        actor=incident.get("trigger_source") or "user",
        activated_at=iso(),
    )
    incident = repo.get_incident(dbp, user["id"], incident["id"])  # type: ignore[assignment]

    share = _mint_share_token(dbp, user, incident, label="Emergency live location")
    notifications = _notify_contacts(dbp, user, incident, share_url=share["url"], place_label=place_label)

    audit(
        dbp,
        action="sos.activate",
        outcome="success",
        actor_id=user["id"],
        actor_label=user.get("name"),
        target_type="incident",
        target_id=incident["id"],
        detail={
            "reference": incident["reference"],
            "hasAnchor": lat is not None,
            "notifications": notifications["counts"],
        },
        **audit_meta(),
    )
    log_event(
        "sos.activated",
        request_id=request_id(),
        user_id=user["id"],
        reference=incident["reference"],
        notified=notifications["counts"],
    )

    incident = repo.get_incident(dbp, user["id"], incident["id"])  # type: ignore[assignment]
    return ok(
        {
            "incident": serialize_incident(incident, dbp=dbp),
            "share": share,
            "notificationSummary": notifications["summary"],
            "nextActions": {
                "call112": "tel:112",
                "stopSharing": "POST /api/location/share/revoke",
            },
            "disclaimer": "SheSafe has not contacted any emergency service. Press Call 112 now if you need police.",
        },
        201,
    )


# --------------------------------------------------------------- escalation


@bp.post("/escalate")
@rate_limit("sos")
@login_required
def escalate():
    """Mark an open incident as ESCALATING (user-initiated or timer-driven)."""
    user = _user()
    dbp = db_path()
    incident = _open_incident(user)
    if incident["state"] == "ESCALATING":
        return ok({"incident": serialize_incident(incident, dbp=dbp), "alreadyEscalating": True})
    repo.transition_incident(
        dbp,
        incident["id"],
        "ESCALATING",
        from_state=incident["state"],
        detail="escalation requested",
    )
    incident = repo.get_incident(dbp, user["id"], incident["id"])  # type: ignore[assignment]
    audit(
        dbp,
        action="sos.escalate",
        outcome="success",
        actor_id=user["id"],
        target_type="incident",
        target_id=incident["id"],
        **audit_meta(),
    )
    return ok({"incident": serialize_incident(incident, dbp=dbp)})


# ---------------------------------------------------------------- resolution


@bp.post("/resolve")
@rate_limit("sos")
@login_required
def resolve():
    """Close the open incident as RESOLVED_SAFE and notify contacts."""
    user = _user()
    dbp = db_path()
    incident = _open_incident(user)
    body = request.get_json(silent=True) or {}
    note = validation.optional_text(body, "note", max_length=300) or "User confirmed they are safe."

    repo.transition_incident(
        dbp,
        incident["id"],
        "RESOLVED",
        from_state=incident["state"],
        detail=note,
        outcome="RESOLVED_SAFE",
        resolution_note=note,
        resolved_at=iso(),
    )
    follow_up = _notify_safe(dbp, user, incident)
    incident = repo.get_incident(dbp, user["id"], incident["id"])  # type: ignore[assignment]

    revoked = _revoke_incident_share_links(dbp, user, incident)

    audit(
        dbp,
        action="sos.resolve",
        outcome="success",
        actor_id=user["id"],
        target_type="incident",
        target_id=incident["id"],
        detail={"reference": incident["reference"], "notifications": follow_up["counts"]},
        **audit_meta(),
    )
    log_event("sos.resolved", request_id=request_id(), user_id=user["id"], reference=incident["reference"])
    return ok(
        {
            "incident": serialize_incident(incident, dbp=dbp),
            "notificationSummary": follow_up["summary"],
            "shareLinksRevoked": revoked,
        }
    )


def _revoke_incident_share_links(dbp, user: dict[str, Any], incident: dict[str, Any]) -> int:
    """Revoke every live share link minted for this incident.

    Standing an emergency down is the user saying *stop*. The link minted by
    ``activate`` used to stay live for its full TTL (an hour by default), so
    after resolve/cancel the guardian console still answered 200 with
    ``linkState: "live"`` and ``sharing: true`` - the location kept streaming to
    anyone holding the link. Links the user created separately are left alone;
    only the ones scoped to this incident are closed.
    """
    revoked = 0
    for token in repo.list_share_tokens(dbp, user["id"]):
        if token.get("incident_id") != incident["id"]:
            continue
        if token.get("revoked_at"):
            continue
        if repo.revoke_share_token(dbp, user["id"], token["id"]):
            revoked += 1
    if revoked:
        log_event(
            "location.share_revoked_on_stand_down",
            request_id=request_id(),
            user_id=user["id"],
            reference=incident.get("reference"),
            revoked=revoked,
        )
    return revoked


@bp.post("/cancel")
@rate_limit("sos")
@login_required
def cancel():
    """Cancel an incident.

    If contacts were already alerted the outcome is ``CANCELLED`` (not
    ``RESOLVED``) so the record always shows that people were contacted, and a
    "false alarm / stood down" message goes out.
    """
    user = _user()
    dbp = db_path()
    incident = _open_incident(user)
    body = request.get_json(silent=True) or {}
    reason = validation.optional_text(body, "reason", max_length=300) or "User cancelled the alert."

    was_contacted = _has_notifications(dbp, incident["id"])
    repo.transition_incident(
        dbp,
        incident["id"],
        "CANCELLED",
        from_state=incident["state"],
        detail=reason,
        outcome="CANCELLED",
        resolution_note=reason,
        resolved_at=iso(),
    )
    follow_up = _notify_safe(dbp, user, incident, reason=reason, cancelled=True) if was_contacted else {
        "summary": serialize_incident(incident, dbp=dbp)["notificationSummary"],
        "counts": {"sent": 0, "simulated": 0, "unavailable": 0, "failed": 0, "skipped": 0},
    }
    incident = repo.get_incident(dbp, user["id"], incident["id"])  # type: ignore[assignment]
    revoked = _revoke_incident_share_links(dbp, user, incident)

    audit(
        dbp,
        action="sos.cancel",
        outcome="success",
        actor_id=user["id"],
        target_type="incident",
        target_id=incident["id"],
        detail={"reference": incident["reference"], "contactsWereNotified": was_contacted},
        **audit_meta(),
    )
    log_event("sos.cancelled", request_id=request_id(), user_id=user["id"], reference=incident["reference"])
    return ok(
        {
            "incident": serialize_incident(incident, dbp=dbp),
            "notificationSummary": follow_up["summary"],
            "contactsWereNotified": was_contacted,
            "shareLinksRevoked": revoked,
        }
    )


# ----------------------------------------------------------------- history


@bp.get("/active")
@rate_limit("read")
@login_required
def active():
    user = _user()
    dbp = db_path()
    incident = repo.find_active_incident(dbp, user["id"])
    return ok({"incident": serialize_incident(incident, dbp=dbp) if incident else None})


@bp.get("/incidents")
@rate_limit("read")
@login_required
def history():
    user = _user()
    dbp = db_path()
    limit = validation.query_int(request.args, "limit", lo=1, hi=100, default=25)
    return ok({"incidents": [serialize_incident(i, include_events=False, dbp=dbp) for i in repo.list_incidents(dbp, user["id"], limit)]})


@bp.get("/incidents/<incident_id>")
@rate_limit("read")
@login_required
def detail(incident_id: str):
    user = _user()
    dbp = db_path()
    incident = repo.get_incident(dbp, user["id"], incident_id)
    if incident is None:
        raise NotFoundError("Incident not found.")
    return ok({"incident": serialize_incident(incident, dbp=dbp)})


# --------------------------------------------------------------- internals


def _user() -> dict[str, Any]:
    from ..security import require_user

    return require_user()


def request_id() -> str | None:
    from flask import g

    return getattr(g, "request_id", None)


def audit_meta() -> dict[str, Any]:
    from .helpers import audit_kwargs

    return audit_kwargs()


def _open_incident(user: dict[str, Any]) -> dict[str, Any]:
    dbp = db_path()
    incident = repo.find_active_incident(dbp, user["id"])
    if incident is None:
        raise ConflictError(
            "No emergency is currently open.", code="no_open_incident"
        )
    return incident


def _has_notifications(dbp, incident_id: str) -> bool:
    rows = repo.list_notifications(dbp, incident_id)
    return any(r["status"] in {"sent", "simulated", "failed"} for r in rows)


def _optional_number(body: dict[str, Any], name: str, *, lo: float, hi: float) -> float | None:
    raw = body.get(name)
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if lo <= value <= hi else None


def _mint_share_token(dbp, user: dict[str, Any], incident: dict[str, Any], *, label: str) -> dict[str, Any]:
    raw_token = new_token(32)
    ttl = int(current_app.config["SHARE_TOKEN_DEFAULT_TTL"])
    expires_at = validation.future_iso(ttl)
    repo.create_share_token(
        dbp,
        user_id=user["id"],
        token_hash=hash_token(raw_token),
        incident_id=incident["id"],
        label=label,
        scope="incident",
        include_trail=bool(user.get("share_trail_by_default", 1)),
        expires_at=expires_at,
    )
    base = request.host_url.rstrip("/")
    return {
        "url": f"{base}/track.html?t={raw_token}",
        "expiresAt": expires_at,
        "ttlSeconds": ttl,
        "scope": "incident",
        "warning": "Anyone with this link can view this location until it expires or you revoke it.",
    }


def _notify_contacts(
    dbp,
    user: dict[str, Any],
    incident: dict[str, Any],
    *,
    share_url: str | None,
    place_label: str | None = None,
) -> dict[str, Any]:
    """Attempt delivery on every configured channel and record the truth."""
    contacts = repo.active_contacts(dbp, user["id"])
    registry = current_app.extensions["shesafe_notifications"]
    anchor = repo.incident_anchor(dbp, incident["id"])
    body = build_emergency_message(
        user_name=user.get("name") or "A SheSafe user",
        reference=incident["reference"],
        lat=(anchor or {}).get("lat"),
        lng=(anchor or {}).get("lng"),
        accuracy_m=(anchor or {}).get("accuracy_m"),
        share_url=share_url,
        triggered_at=incident.get("activated_at") or incident.get("created_at") or iso(),
    )
    counts = {"sent": 0, "simulated": 0, "unavailable": 0, "failed": 0, "skipped": 0}
    for contact in contacts:
        for channel in contact.get("channels") or ["sms"]:
            provider = registry.get(channel)
            context = {} if (not provider.is_configured() and provider.name == "none") else {
                "incident_id": incident["id"]
            }
            result = _attempt(provider, contact, channel, body, context)
            counts[result.status] = counts.get(result.status, 0) + 1
            repo.record_notification(
                dbp,
                incident_id=incident["id"],
                user_id=user["id"],
                contact_id=contact["id"],
                channel=channel,
                provider=result.provider,
                destination=result.destination,
                body_preview=body[:180],
                status=result.status,
                detail=result.detail,
            )
    incident_view = repo.get_incident(dbp, user["id"], incident["id"]) or incident
    summary = serialize_incident(incident_view, include_events=False, dbp=dbp)["notificationSummary"]
    if not contacts:
        summary = {
            **summary,
            "statement": (
                "No emergency contacts are configured, so no alert could be sent. "
                "SheSafe has not contacted police, ambulance or any government service. Press Call 112 now."
            ),
        }
    return {"counts": counts, "summary": summary, "contacts": len(contacts)}


def _attempt(provider, contact: dict[str, Any], channel: str, body: str, context: dict[str, Any]):
    """Send one message, converting a raising provider into a recorded failure.

    A provider that raises must never abort the surrounding emergency action.
    In ``_notify_contacts`` that meant the request 500'd *after* the incident was
    already ACTIVE and the link minted, leaving an open emergency that had
    alerted nobody, no ``notification_attempts`` row, and a retry that was then
    suppressed as a duplicate. The same guard keeps a failing provider from
    turning a successful stand-down into a 500.
    """
    try:
        return provider.send(contact["phone"], body, context)
    except Exception as exc:  # noqa: BLE001 - deliberately broad; see docstring
        log_event(
            "sos.notify_failed",
            request_id=request_id(),
            channel=channel,
            provider=provider.name,
            contact_id=contact.get("id"),
            error=f"{type(exc).__name__}: {exc}"[:180],
        )
        return DeliveryResult(
            channel=channel,
            provider=provider.name,
            destination=contact.get("phone") or "",
            status="failed",
            detail=f"Provider raised {type(exc).__name__} before reporting a result.",
        )


def _notify_safe(
    dbp, user: dict[str, Any], incident: dict[str, Any], *, reason: str | None = None, cancelled: bool = False
) -> dict[str, Any]:
    from ..notifications import build_safe_message

    contacts = repo.active_contacts(dbp, user["id"])
    registry = current_app.extensions["shesafe_notifications"]
    body = build_safe_message(
        user_name=user.get("name") or "A SheSafe user",
        reference=incident["reference"],
        resolved_at=iso(),
    )
    counts = {"sent": 0, "simulated": 0, "unavailable": 0, "failed": 0, "skipped": 0}
    for contact in contacts:
        for channel in contact.get("channels") or ["sms"]:
            provider = registry.get(channel)
            result = _attempt(provider, contact, channel, body, {"incident_id": incident["id"]})
            counts[result.status] = counts.get(result.status, 0) + 1
            repo.record_notification(
                dbp,
                incident_id=incident["id"],
                user_id=user["id"],
                contact_id=contact["id"],
                channel=channel,
                provider=result.provider,
                destination=result.destination,
                body_preview=body[:180],
                status=result.status,
                detail=result.detail,
            )
    incident_view = repo.get_incident(dbp, user["id"], incident["id"]) or incident
    summary = serialize_incident(incident_view, include_events=False, dbp=dbp)["notificationSummary"]
    return {"counts": counts, "summary": summary}