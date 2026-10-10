"""Journey Guard.

States: ``ON_JOURNEY`` -> ``CHECK_IN_REQUIRED`` -> ``WARNING`` -> ``EMERGENCY``,
plus ``ARRIVED`` and ``CANCELLED``.

Honesty about the platform: a web page **cannot** reliably monitor a user in the
background once the tab is closed or the phone is locked. SheSafe therefore
(a) records journey state server-side so it survives a reload, (b) advances
states on read when the client has gone quiet, and (c) states plainly in every
response that active monitoring requires the app to be open.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, request

from .. import repo, validation
from ..errors import ConflictError, NotFoundError
from ..logging_utils import audit, human_reference, iso, log_event
from ..security import login_required, rate_limit, require_user
from ..validation import require_json
from .helpers import db_path, ok, serialize_journey

bp = Blueprint("journeys", __name__, url_prefix="/api/journeys")

MONITORING_DISCLAIMER = (
    "Journey Guard needs this page open to advance its timer on time. Browsers cannot keep "
    "waking a closed tab reliably. If the app is closed, escalation happens when you next reopen it."
)

GRACE_MINUTES = 3


@bp.get("")
@rate_limit("read")
@login_required
def list_all():
    user = require_user()
    dbp = db_path()
    journeys = repo.list_journeys(dbp, user["id"], limit=15)
    return ok(
        {
            "journeys": [serialize_journey(j, dbp=dbp) for j in journeys],
            "disclaimer": MONITORING_DISCLAIMER,
        }
    )


@bp.get("/active")
@rate_limit("read")
@login_required
def active():
    """Read state, advancing it if the expected arrival has passed.

    The state machine is evaluated here so a returning client always sees the
    truth, even if the browser timer never fired.
    """
    user = require_user()
    dbp = db_path()
    journey = repo.active_journey(dbp, user["id"])
    if journey is None:
        return ok({"journey": None, "disclaimer": MONITORING_DISCLAIMER})
    journey = _advance(dbp, user, journey)
    return ok(
        {
            "journey": serialize_journey(journey, dbp=dbp),
            "requiresAction": journey["state"] in {"CHECK_IN_REQUIRED", "WARNING"},
            "disclaimer": MONITORING_DISCLAIMER,
        }
    )


@bp.post("")
@rate_limit("write")
@login_required
def create():
    user = require_user()
    dbp = db_path()
    body = require_json(request)

    if repo.active_journey(dbp, user["id"]):
        raise ConflictError("A journey is already in progress.", code="journey_in_progress")

    origin = validation.field(body, "origin", max_length=120, label="Starting point")
    destination = validation.field(body, "destination", max_length=120, label="Destination")
    minutes = validation.int_field(body, "expectedMinutes", minimum=1, maximum=24 * 60, label="Expected travel time")
    contact_id = body.get("contactId")
    if contact_id:
        contact_id = validation.field({"contactId": contact_id}, "contactId", max_length=64, label="Contact")
        if repo.get_contact(dbp, user["id"], contact_id) is None:
            raise NotFoundError("That contact does not exist.")

    now = datetime.now(timezone.utc)
    journey = repo.create_journey(
        dbp,
        user["id"],
        {
            "origin_label": origin,
            "destination_label": destination,
            "expected_minutes": minutes,
            "contact_id": contact_id,
            "due_at": iso(now + timedelta(minutes=minutes)),
        },
    )
    repo.create_check_in(
        dbp,
        user["id"],
        {
            "journey_id": journey["id"],
            "message": f"Journey started: {origin} to {destination} (expected {minutes} min).",
            "place_label": origin,
        },
    )
    audit(
        dbp,
        action="journey.start",
        outcome="success",
        actor_id=user["id"],
        target_type="journey",
        target_id=journey["id"],
        detail={"expectedMinutes": minutes, "hasContact": bool(contact_id)},
        **audit_kwargs(),
    )
    log_event("journey.started", request_id=request_id(), user_id=user["id"], journey_id=journey["id"])
    return ok({"journey": serialize_journey(journey, dbp=dbp), "disclaimer": MONITORING_DISCLAIMER}, 201)


@bp.post("/<journey_id>/checkin")
@rate_limit("write")
@login_required
def checkin(journey_id: str):
    """User confirms arrival. Closes the journey and tells contacts."""
    user = require_user()
    dbp = db_path()
    journey = repo.get_journey(dbp, user["id"], journey_id)
    if journey is None:
        raise NotFoundError("Journey not found.")
    if journey["state"] in {"ARRIVED", "CANCELLED"}:
        return ok({"journey": serialize_journey(journey, dbp=dbp), "alreadyClosed": True})

    body = request.get_json(silent=True) or {}
    note = validation.optional_text(body, "note", max_length=200)
    repo.transition_journey(
        dbp,
        journey_id,
        "ARRIVED",
        from_state=journey["state"],
        detail=note or "User confirmed arrival",
        checked_in_at=iso(),
        ended_at=iso(),
    )
    check_in = repo.create_check_in(
        dbp,
        user["id"],
        {
            "journey_id": journey_id,
            "message": f"Arrived safely: {journey['destination_label']}.",
            "place_label": journey["destination_label"],
        },
    )
    audit(dbp, action="journey.checkin", outcome="success", actor_id=user["id"], target_type="journey", target_id=journey_id, **audit_kwargs())
    journey = repo.get_journey(dbp, user["id"], journey_id)
    return ok({"journey": serialize_journey(journey, dbp=dbp), "checkInId": check_in["id"], "disclaimer": MONITORING_DISCLAIMER})


@bp.post("/<journey_id>/cancel")
@rate_limit("write")
@login_required
def cancel(journey_id: str):
    user = require_user()
    dbp = db_path()
    journey = repo.get_journey(dbp, user["id"], journey_id)
    if journey is None:
        raise NotFoundError("Journey not found.")
    if journey["state"] == "CANCELLED":
        return ok({"journey": serialize_journey(journey, dbp=dbp), "alreadyClosed": True})
    repo.transition_journey(
        dbp, journey_id, "CANCELLED", from_state=journey["state"], detail="cancelled by user", ended_at=iso()
    )
    audit(dbp, action="journey.cancel", outcome="success", actor_id=user["id"], target_type="journey", target_id=journey_id, **audit_kwargs())
    return ok({"journey": serialize_journey(repo.get_journey(dbp, user["id"], journey_id), dbp=dbp)})


@bp.post("/<journey_id>/escalate")
@rate_limit("sos")
@login_required
def escalate(journey_id: str):
    """Explicitly escalate a journey to a real SOS incident."""
    user = require_user()
    dbp = db_path()
    journey = repo.get_journey(dbp, user["id"], journey_id)
    if journey is None:
        raise NotFoundError("Journey not found.")
    if journey["state"] == "EMERGENCY":
        raise ConflictError("This journey has already escalated.", code="already_escalated")

    journey, incident = _escalate_journey(dbp, user, journey, detail="user requested escalation")
    audit(
        dbp,
        action="journey.escalate",
        outcome="success",
        actor_id=user["id"],
        target_type="journey",
        target_id=journey_id,
        detail={"incidentId": incident["id"]},
        **audit_kwargs(),
    )
    return ok(
        {
            "journey": serialize_journey(journey, dbp=dbp),
            "incidentId": incident["id"],
            "reference": incident["reference"],
            "note": "SOS is now active. Use Call 112 to reach emergency services.",
        }
    )


# --------------------------------------------------------------- internals


def _advance(dbp, user: dict, journey: dict) -> dict:
    """Evaluate the journey state machine against the clock."""
    state = journey["state"]
    if state not in {"ON_JOURNEY", "CHECK_IN_REQUIRED", "WARNING"}:
        return journey

    now = datetime.now(timezone.utc)
    due = _parse(journey["due_at"]) or now
    overdue = (now - due).total_seconds()

    if overdue <= 0:
        if state != "ON_JOURNEY":
            repo.transition_journey(dbp, journey["id"], "ON_JOURNEY", from_state=state, detail="deadline extended")
            journey = repo.get_journey(dbp, journey["user_id"], journey["id"])
        return journey

    if overdue <= GRACE_MINUTES * 60 and state == "ON_JOURNEY":
        repo.transition_journey(
            dbp,
            journey["id"],
            "CHECK_IN_REQUIRED",
            from_state=state,
            detail="expected arrival time reached",
            grace_until=iso(now + timedelta(minutes=GRACE_MINUTES)),
        )
        log_event("journey.checkin_required", journey_id=journey["id"], user_id=journey["user_id"])
        journey = repo.get_journey(dbp, journey["user_id"], journey["id"])
        state = journey["state"]

    if overdue > GRACE_MINUTES * 60:
        journey, _incident = _escalate_journey(
            dbp, user, journey, detail="grace period exceeded; automatically escalated"
        )
        log_event("journey.escalated", journey_id=journey["id"], user_id=journey["user_id"])

    return journey


def _escalate_journey(dbp, user: dict, journey: dict, *, detail: str) -> tuple[dict, dict]:
    """Open an active SOS and notify trusted contacts for a journey escalation."""
    from . import sos as sos_api

    existing = repo.find_active_incident(dbp, user["id"])
    if existing:
        incident = existing
    else:
        incident = repo.create_incident(
            dbp, user["id"], reference=human_reference("SS"), trigger_source="journey", state="COUNTDOWN"
        )
        sample = repo.latest_location(dbp, user["id"])
        if sample:
            repo.record_incident_location(
                dbp, incident["id"], sample["lat"], sample["lng"], sample.get("accuracy_m"), "gps"
            )
        repo.transition_incident(
            dbp,
            incident["id"],
            "ACTIVE",
            from_state="COUNTDOWN",
            detail=f"escalated from Journey Guard {journey['id']}",
            actor="journey",
            activated_at=iso(),
        )
        incident = repo.get_incident(dbp, user["id"], incident["id"])
        share = sos_api._mint_share_token(dbp, user, incident, label="Journey Guard escalation")
        sos_api._notify_contacts(dbp, user, incident, share_url=share["url"])
        incident = repo.get_incident(dbp, user["id"], incident["id"])

    repo.transition_journey(
        dbp,
        journey["id"],
        "EMERGENCY",
        from_state=journey["state"],
        detail=detail,
        escalated_at=iso(),
        escalated_incident_id=incident["id"],
    )
    return repo.get_journey(dbp, user["id"], journey["id"]), incident


def _parse(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def audit_kwargs() -> dict:
    from .helpers import audit_kwargs as _kwargs

    return _kwargs()


def request_id() -> str | None:
    from flask import g

    return getattr(g, "request_id", None)