"""Check-ins, community reports and moderation.

Moderation model
----------------
A submission starts as ``COMMUNITY_REPORTED`` and can only reach ``VERIFIED``
through an explicit moderation action. There is **no** code path by which a user
submission becomes verified automatically, and the feed labels every item with
its state so a community report is never read as established fact.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, request

from .. import repo, validation
from ..errors import AuthorizationError, ConflictError, NotFoundError, ValidationError
from ..logging_utils import audit, iso, log_event
from ..security import login_required, rate_limit, require_user
from ..validation import require_json
from .helpers import db_path, ok, serialize_report

bp = Blueprint("reports", __name__, url_prefix="/api")

CATEGORIES = (
    "stalking",
    "harassment",
    "eve_teasing",
    "theft",
    "assault",
    "unsafe_area",
    "medical",
    "accident",
    "domestic_violence",
    "other",
)
SEVERITIES = ("low", "moderate", "high", "critical")


# ------------------------------------------------------------- check-ins


@bp.get("/checkins")
@rate_limit("read")
@login_required
def list_checkins():
    user = require_user()
    dbp = db_path()
    limit = validation.query_int(request.args, "limit", lo=1, hi=50, default=10)
    return ok({"checkIns": repo.list_check_ins(dbp, user["id"], limit)})


@bp.post("/checkins")
@rate_limit("write")
@login_required
def create_checkin():
    user = require_user()
    dbp = db_path()
    body = request.get_json(silent=True) or {}
    sample = repo.latest_location(dbp, user["id"])
    journey = repo.active_journey(dbp, user["id"])
    incident = repo.find_active_incident(dbp, user["id"])
    place = validation.optional_text(body, "placeLabel", max_length=200) or (
        f"{sample['lat']:.4f}, {sample['lng']:.4f}" if sample else "Location unavailable"
    )
    check_in = repo.create_check_in(
        dbp,
        user["id"],
        {
            "journey_id": journey["id"] if journey else None,
            "incident_id": incident["id"] if incident else None,
            "message": f"{user['name']} checked in as safe.",
            "place_label": place,
        },
    )
    if journey and journey["state"] not in {"ARRIVED", "CANCELLED"}:
        repo.transition_journey(
            dbp, journey["id"], "ARRIVED", from_state=journey["state"], detail="check-in received", checked_in_at=iso(), ended_at=iso()
        )
    audit(dbp, action="checkin.create", outcome="success", actor_id=user["id"], target_type="checkin", target_id=check_in["id"], **audit_kwargs())
    return ok({"checkIn": check_in}, 201)


# ------------------------------------------------------- community reports


@bp.get("/reports")
@rate_limit("read")
@login_required
def list_reports():
    dbp = db_path()
    lat = validation.query_float(request.args, "lat", lo=-90, hi=90, default=None)
    lng = validation.query_float(request.args, "lng", lo=-180, hi=180, default=None)
    radius = validation.query_float(request.args, "radiusKm", lo=0.2, hi=50, default=5.0)
    state_filter = request.args.get("state")
    states = tuple(state_filter.split(",")) if state_filter else ("COMMUNITY_REPORTED", "UNDER_REVIEW", "VERIFIED")
    invalid = [s for s in states if s not in repo.REPORT_STATES]
    if invalid:
        raise ValidationError(f"Unknown state(s): {', '.join(invalid)}.", state="invalid")
    near = (lat, lng) if lat is not None and lng is not None else None
    reports = repo.list_reports(dbp, states=states, near=near, radius_km=radius, limit=50)
    return ok(
        {
            "reports": [serialize_report(r) for r in reports],
            "stateLegend": {
                "COMMUNITY_REPORTED": "Reported by a user. Not verified. Treat as a lead, not a fact.",
                "UNDER_REVIEW": "A moderator is reviewing this report.",
                "VERIFIED": "Corroborated by a moderator or an independent source.",
                "DISMISSED": "Reviewed and found unsupported.",
                "RESOLVED": "Actioned and closed.",
            },
        }
    )


@bp.post("/reports")
@rate_limit("write")
@login_required
def create_report():
    user = require_user()
    dbp = db_path()
    body = require_json(request)

    category = validation.enum_field(body, "category", CATEGORIES, required=False, default="other", label="Category")
    title = validation.field(body, "title", max_length=120, label="Headline", pattern=validation.NAME_RE)
    description = validation.optional_text(body, "description", max_length=2000)
    place_label = validation.optional_text(body, "placeLabel", max_length=200)
    anonymous = validation.bool_field(body, "anonymous", default=False)
    lat = validation.lat_field(body, "lat", required=False)
    lng = validation.lng_field(body, "lng", required=False)
    severity = validation.enum_field(body, "severity", SEVERITIES, required=False, default="moderate", label="Severity")
    evidence_url = validation.optional_text(body, "evidenceUrl", max_length=300)
    if evidence_url and not evidence_url.startswith(("http://", "https://")):
        raise ValidationError("Evidence link must start with http:// or https://", evidenceUrl="invalid")

    # Moderation safeguard: one report per account per 10 minutes.
    recent = db_query_recent(dbp, user["id"])
    if recent:
        raise ConflictError("You submitted a report very recently. Please wait before posting again.", code="rate_limited_report")

    report = repo.create_report(
        dbp,
        {
            "user_id": None if anonymous else user["id"],
            "category": category,
            "title": title,
            "description": description,
            "place_label": place_label,
            "lat": lat,
            "lng": lng,
            "occurred_at": validation.optional_text(body, "occurredAt", max_length=40),
            "anonymous": anonymous,
            "evidence_url": evidence_url,
        },
    )
    audit(
        dbp,
        action="report.create",
        outcome="success",
        actor_id=user["id"],
        target_type="report",
        target_id=report["id"],
        detail={"category": category, "anonymous": anonymous},
        **audit_kwargs(),
    )
    return ok(
        {
            "report": serialize_report(report),
            "notice": "Submitted as COMMUNITY_REPORTED. It is not verified and will not be presented as confirmed fact.",
        },
        201,
    )


@bp.post("/reports/<report_id>/helpful")
@rate_limit("write")
@login_required
def mark_helpful(report_id: str):
    """Signal that a report seems useful. One signal per user; never verification."""
    user = require_user()
    dbp = db_path()
    if repo.get_report(dbp, report_id) is None:
        raise NotFoundError("Report not found.")
    created, count = repo.vote_for_report(dbp, report_id, user["id"])
    audit(
        dbp,
        action="report.helpful",
        outcome="success" if created else "duplicate",
        actor_id=user["id"],
        target_type="report",
        target_id=report_id,
        **audit_kwargs(),
    )
    return ok({"helpfulCount": count, "counted": created})


@bp.post("/reports/<report_id>/moderate")
@rate_limit("write")
@login_required
def moderate(report_id: str):
    """Moderation action.

    In this build moderation is available to any signed-in user, which is
    explicitly a demo affordance, not a production permission model. The
    response says so.
    """
    user = require_user()
    dbp = db_path()
    body = require_json(request)
    target = validation.enum_field(
        body, "state", {"UNDER_REVIEW", "VERIFIED", "DISMISSED", "RESOLVED"}, label="New state"
    )
    note = validation.optional_text(body, "note", max_length=500)
    confidence = validation.optional_text(body, "confidence", max_length=10)

    if repo.get_report(dbp, report_id) is None:
        raise NotFoundError("Report not found.")

    conf = 0.0
    if confidence is not None:
        try:
            conf = max(0.0, min(1.0, float(confidence)))
        except ValueError:
            conf = 0.0
    if target == "VERIFIED" and conf < 0.5:
        raise ValidationError("Verification requires a confidence of at least 0.5 and a moderator note.", confidence="too_low")

    report = repo.set_report_state(dbp, report_id, target, moderator_note=note, confidence=conf)
    audit(
        dbp,
        action="report.moderate",
        outcome="success",
        actor_id=user["id"],
        target_type="report",
        target_id=report_id,
        detail={"state": target, "confidence": conf},
        **audit_kwargs(),
    )
    log_event("report.moderated", request_id=request_id(), report_id=report_id, state=target)
    return ok(
        {
            "report": serialize_report(report),
            "note": "Demo build: any signed-in user can moderate. A production deployment would require a moderator role.",
        }
    )


def db_query_recent(dbp, user_id: str):
    from .. import db as dbmod

    rows = dbmod.query(
        dbp,
        """
        SELECT created_at FROM community_reports
        WHERE user_id = ? AND created_at > ?
        LIMIT 1
        """,
        (user_id, iso(datetime.now(timezone.utc) - timedelta(minutes=10))),
    )
    return dbmod.rows_to_dicts(rows)


def audit_kwargs() -> dict:
    from .helpers import audit_kwargs as _kwargs

    return _kwargs()


def request_id() -> str | None:
    from flask import g

    return getattr(g, "request_id", None)