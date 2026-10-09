"""Shared API helpers: envelope, serialisation, session loading."""

from __future__ import annotations

from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable

from flask import current_app, g, jsonify, request

from .. import repo, timeline
from ..logging_utils import iso
from ..security import client_identity, ip_hash


def db_path():
    return current_app.config["DATABASE_PATH"]


def ok(payload: dict[str, Any] | None = None, status: int = 200):
    body = {"ok": True}
    if payload:
        body.update(payload)
    response = jsonify(body)
    response.status_code = status
    return response


def bearer_route(f: Callable) -> Callable:
    """Marks a view as reachable with a share token instead of a session.

    Used only by the guardian/tracking endpoint. The token itself is the
    credential; there is no way to reach that endpoint with a user id.
    """

    @wraps(f)
    def wrapper(*args, **kwargs):
        g.auth_mode = "share_token"
        return f(*args, **kwargs)

    return wrapper


def public_user(user: dict[str, Any] | None) -> dict[str, Any] | None:
    """Strip every internal field. ``password_hash`` never leaves the repository."""
    if user is None:
        return None
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user.get("email"),
        "phone": user.get("phone"),
        "bloodGroup": user.get("blood_group"),
        "emergencyNotes": user.get("emergency_notes"),
        "homeArea": user.get("home_area"),
        "sirenEnabled": bool(user.get("siren_enabled")),
        "voiceSosEnabled": bool(user.get("voice_sos_enabled")),
        "locationConsent": bool(user.get("location_consent")),
        "shareTrailByDefault": bool(user.get("share_trail_by_default", 1)),
        "createdAt": user.get("created_at"),
    }


def public_contact(contact: dict[str, Any]) -> dict[str, Any]:
    verified_by = contact.get("verified_by")
    return {
        "id": contact["id"],
        "name": contact["name"],
        "relationship": contact.get("relationship"),
        "phone": contact.get("phone"),
        "channels": contact.get("channels") or [],
        "isPrimary": bool(contact.get("is_primary")),
        "verified": bool(contact.get("verified")),
        "verifiedBy": verified_by,
        "verifiedAt": contact.get("verified_at"),
        "verificationRequestedAt": contact.get("verification_requested_at"),
        "verificationPending": bool(contact.get("verification_code_hash")),
        "active": bool(contact.get("active")),
        "createdAt": contact.get("created_at"),
    }


def public_location(sample: dict[str, Any] | None) -> dict[str, Any] | None:
    if sample is None:
        return None
    return {
        "lat": sample["lat"],
        "lng": sample["lng"],
        "accuracyM": sample.get("accuracy_m"),
        "speedMps": sample.get("speed_mps"),
        "headingDeg": sample.get("heading_deg"),
        "batteryPct": sample.get("battery_pct"),
        "source": sample.get("source"),
        "recordedAt": sample.get("created_at"),
    }


def is_stale(recorded_at: str | None, stale_after_seconds: int) -> bool:
    if not recorded_at:
        return True
    try:
        parsed = datetime.fromisoformat(str(recorded_at).replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - parsed).total_seconds()
    return age > stale_after_seconds


def age_seconds(recorded_at: str | None) -> int | None:
    if not recorded_at:
        return None
    try:
        parsed = datetime.fromisoformat(str(recorded_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int((datetime.now(timezone.utc) - parsed).total_seconds())


def audit_kwargs() -> dict[str, Any]:
    return {
        "request_id": getattr(g, "request_id", None),
        "ip_hash": ip_hash(client_identity()),
    }


def serialize_incident(incident: dict[str, Any], *, include_events: bool = True, dbp=None) -> dict[str, Any]:
    dbp = dbp or db_path()
    events = repo.list_incident_events(dbp, incident["id"]) if include_events else []
    anchor = repo.incident_anchor(dbp, incident["id"])
    notifications = repo.list_notifications(dbp, incident["id"])
    user = repo.get_user(dbp, incident["user_id"])
    outcome = incident.get("outcome")
    duration_minutes = None
    started = incident.get("activated_at") or incident.get("started_at")
    ended = incident.get("resolved_at")
    if started and ended:
        try:
            s = datetime.fromisoformat(started.replace("Z", "+00:00"))
            e = datetime.fromisoformat(ended.replace("Z", "+00:00"))
            duration_minutes = round((e - s).total_seconds() / 60.0, 1)
        except ValueError:
            duration_minutes = None

    payload = {
        "id": incident["id"],
        "reference": incident["reference"],
        "state": incident["state"],
        "triggerSource": incident.get("trigger_source"),
        "startedAt": incident.get("started_at"),
        "activatedAt": incident.get("activated_at"),
        "resolvedAt": incident.get("resolved_at"),
        "outcome": outcome,
        "resolutionNote": incident.get("resolution_note"),
        "durationMinutes": duration_minutes,
        "location": public_location(anchor) if anchor else None,
        # The lifecycle in order: one entry per stored state change.
        "timeline": [
            {
                "state": e["to_state"],
                "from": e["from_state"],
                "detail": e["detail"],
                "actor": e["actor"],
                "at": e["created_at"],
            }
            for e in events
        ],
        # The same record in the shared timeline vocabulary, enriched with the
        # location and notification events a person actually needs to read it.
        "safetyTimeline": safety_timeline(dbp, incident, events),
        "notifications": [
            {
                "channel": n["channel"],
                "provider": n["provider"],
                "status": n["status"],
                "delivered": n["status"] == "sent",
                "detail": n.get("detail"),
                "at": n["created_at"],
            }
            for n in notifications
        ],
        "userName": (user or {}).get("name"),
    }
    summary = notifications_summary(notifications)
    payload["notificationSummary"] = summary
    return payload


def notifications_summary(notifications: list[dict[str, Any]]) -> dict[str, Any]:
    """The honest headline: what actually happened, per status."""
    delivered = [n for n in notifications if n["status"] == "sent"]
    simulated = [n for n in notifications if n["status"] == "simulated"]
    unavailable = [n for n in notifications if n["status"] == "unavailable"]
    failed = [n for n in notifications if n["status"] == "failed"]
    skipped = [n for n in notifications if n["status"] == "skipped"]
    return {
        "delivered": len(delivered),
        "simulated": len(simulated),
        "unavailable": len(unavailable),
        "failed": len(failed),
        "skipped": len(skipped),
        "policeNotified": False,
        "statement": _notification_statement(delivered, simulated, unavailable, failed),
    }


def _notification_statement(delivered, simulated, unavailable, failed) -> str:
    parts: list[str] = []
    if delivered:
        parts.append(f"{len(delivered)} message(s) confirmed delivered by a provider")
    if simulated:
        parts.append(f"{len(simulated)} recorded as SIMULATED (no external message sent)")
    if unavailable:
        parts.append(f"{len(unavailable)} channel(s) UNAVAILABLE")
    if failed:
        parts.append(f"{len(failed)} FAILED")
    if not parts:
        parts.append("no outbound message was attempted")
    return (
        "SheSafe sent: " + ", ".join(parts) + ". SheSafe did not contact police, ambulance or any "
        "government service. Use the Call 112 action to reach emergency services."
    )


def safety_timeline(dbp, incident: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The incident record in the shared timeline vocabulary.

    Every entry carries a timestamp, an event type, a status and a sentence a
    person can read. Built from stored rows only — the location anchor and the
    notification attempts that really happened, never the ones that might.
    """
    anchor = repo.incident_anchor(dbp, incident["id"])
    notifications = repo.list_notifications(dbp, incident["id"])
    shares = [
        token for token in repo.list_share_tokens(dbp, incident["user_id"]) if token.get("incident_id") == incident["id"]
    ]
    return timeline.merge(
        [timeline.event(e["created_at"], e["to_state"], detail=e["detail"], actor=e["actor"]) for e in events],
        (timeline.sharing_events(shares[0]) if shares else []),
        [timeline.location_event(anchor, label="Anchor position captured")] if anchor else [],
        [timeline.notification_event(n) for n in notifications],
    )


def serialize_journey(journey: dict[str, Any], *, dbp=None) -> dict[str, Any]:
    events = []
    if dbp is not None:
        events = serialize_journey_timeline(dbp, journey)
    return {
        "id": journey["id"],
        "origin": journey.get("origin_label"),
        "destination": journey.get("destination_label"),
        "expectedMinutes": journey.get("expected_minutes"),
        "contactId": journey.get("contact_id"),
        "state": journey["state"],
        "startedAt": journey.get("started_at"),
        "dueAt": journey.get("due_at"),
        "graceUntil": journey.get("grace_until"),
        "checkedInAt": journey.get("checked_in_at"),
        "escalatedAt": journey.get("escalated_at"),
        "escalatedIncidentId": journey.get("escalated_incident_id"),
        "endedAt": journey.get("ended_at"),
        "timeline": events,
    }


def serialize_journey_timeline(dbp, journey: dict[str, Any]) -> list[dict[str, Any]]:
    """A Journey Guard record in the shared timeline shape.

    Built from ``journey_events`` (the stored state changes) plus the check-ins
    the user actually made. A state that never occurred is not present, so the
    ladder on screen is the ladder that ran.

    Ordering note: a state change and the check-in written alongside it share the
    same one-second timestamp, so the row order cannot be recovered from the
    clock alone. Each check-in is therefore attached to the state it belongs to,
    which is both exact for the two kinds that exist and stable for any new kind
    (which lands after the last state change rather than interleaving wrongly).
    """
    events = repo.list_journey_events(dbp, journey["id"])
    check_ins = [
        check_in
        for check_in in reversed(repo.list_check_ins(dbp, journey["user_id"], limit=50))
        if check_in.get("journey_id") == journey["id"]
    ]

    entries: list[dict[str, Any]] = []
    used: set[str] = set()
    for event in events:
        state = event["to_state"]
        entries.append(
            timeline.event(event["created_at"], state, table=timeline.JOURNEY_LIFECYCLE, detail=event["detail"])
        )
        for check_in in check_ins:
            message = check_in.get("message") or ""
            kind = "ON_JOURNEY" if message.startswith("Journey started") else "ARRIVED"
            if kind == state:
                entries.append(_check_in_event(check_in, journey, kind))
                used.add(str(check_in.get("id")))
    # A check-in that could not be attached to a stored state still happened.
    for check_in in check_ins:
        if str(check_in.get("id")) not in used:
            entries.append(_check_in_event(check_in, journey, "ARRIVED"))
    return timeline.merge(entries)


def _check_in_event(check_in: dict[str, Any], journey: dict[str, Any], kind: str) -> dict[str, Any]:
    message = check_in.get("message") or ""
    opened = kind == "ON_JOURNEY"
    return {
        "at": check_in.get("created_at"),
        "state": "CHECK_IN",
        "type": "journey" if opened else "checkin",
        "status": "closed" if journey["state"] == "ARRIVED" else "active",
        "label": "Journey record opened" if opened else "Check-in recorded",
        "explanation": message or "A check-in was recorded against this journey.",
        "actor": "user",
        "detail": check_in.get("place_label"),
    }


def serialize_report(report: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": report["id"],
        "category": report["category"],
        "title": report["title"],
        "description": report.get("description"),
        "placeLabel": report.get("place_label"),
        "lat": report.get("lat"),
        "lng": report.get("lng"),
        "occurredAt": report.get("occurred_at"),
        "anonymous": bool(report.get("anonymous")),
        "state": report["state"],
        "stateLabel": STATE_LABELS.get(report["state"], report["state"]),
        "confidence": round(float(report.get("confidence") or 0.0), 2),
        "helpfulCount": report.get("helpful_count", 0),
        "reportCount": report.get("report_count", 1),
        "evidenceUrl": report.get("evidence_url"),
        "moderatorNote": report.get("moderator_note"),
        "distanceKm": report.get("distance_km"),
        "createdAt": report.get("created_at"),
    }


STATE_LABELS = {
    "COMMUNITY_REPORTED": "Community reported",
    "UNDER_REVIEW": "Under review",
    "VERIFIED": "Verified",
    "DISMISSED": "Dismissed",
    "RESOLVED": "Resolved",
}


def client_request_metadata() -> dict[str, Any]:
    return {"request_id": getattr(g, "request_id", None), "ip_hash": ip_hash(client_identity())}


def now_iso() -> str:
    return iso()