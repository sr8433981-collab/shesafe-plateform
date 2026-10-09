"""Privacy, retention, export and account deletion.

This blueprint is the concrete answer to "what happens to my data". Every claim
in the Privacy screen is produced here, from the same configuration the rest of
the app uses, so the screen cannot drift from the behaviour.

Endpoints
---------
``GET    /api/privacy/retention``  what is stored and for how long
``POST   /api/privacy/export``     a portable, sealed copy of the account
``POST   /api/privacy/cleanup``    run the retention job now (operator/demo)
``DELETE /api/account``            delete the account and its personal data
"""

from __future__ import annotations

from flask import Blueprint, current_app, request

from .. import repo
from ..errors import AuthorizationError, ServiceUnavailableError, ValidationError
from ..logging_utils import audit, iso, log_event
from ..security import login_required, rate_limit, require_user
from .helpers import audit_kwargs, db_path, ok, public_contact, serialize_incident, serialize_journey, serialize_report
from .reports import MODERATOR_ROLES

bp = Blueprint("privacy", __name__, url_prefix="/api")


def _may_run_retention(user: dict) -> bool:
    """Who may run the table-wide retention purge.

    Mirrors ``reports.moderation_is_open``: a moderator always may, Demo Mode may
    so the retention story can be demonstrated on stage, and production may
    only ever be run by a moderator.
    """
    if str(user.get("role") or "user").lower() in MODERATOR_ROLES:
        return True
    cfg = current_app.config
    if cfg.get("ENV") == "production":
        return False
    return bool(cfg.get("DEMO_MODE", False))

#: What SheSafe stores that can identify a person, and why.
DATA_CATEGORIES = [
    {
        "id": "identity",
        "label": "Account identity",
        "why": "So you can sign in and so an incident record has an owner.",
        "retention": "Until you delete your account.",
    },
    {
        "id": "contacts",
        "label": "Trusted contacts",
        "why": "So an emergency can name who would be alerted, and on which channel.",
        "retention": "Until you delete them or your account.",
    },
    {
        "id": "location",
        "label": "Location samples",
        "why": "So SOS can attach a position and a guardian can follow a share link.",
        "retention": "Incident trail: kept with the incident. Everything else: a short rolling window.",
    },
    {
        "id": "audit",
        "label": "Audit log",
        "why": "So a security investigation is possible after the fact.",
        "retention": "A bounded window. Coordinates are coarsened before they are written.",
    },
    {
        "id": "incident",
        "label": "Incident records",
        "why": "So you have a record of what happened and when you escalated.",
        "retention": "Kept, anonymised, when you delete your account.",
    },
]


@bp.get("/privacy/retention")
@rate_limit("read")
@login_required
def retention():
    require_user()
    dbp = db_path()
    report = repo.retention_report(dbp, dict(current_app.config))
    return ok(
        {
            **report,
            "categories": DATA_CATEGORIES,
            "notes": [
                "Share tokens store only a SHA-256 hash, so a database leak cannot be replayed.",
                "The audit log coarsens coordinates before writing them; precise values are never logged.",
                "Deletion removes your contacts, locations, journeys, check-ins, notification records and audit actor entries.",
                "Incident rows survive account deletion without an owner, so the safety record is not silently rewritten.",
            ],
        }
    )


@bp.post("/privacy/export")
@rate_limit("write")
@login_required
def export_account():
    """A portable copy of everything SheSafe holds about this account.

    Coordinates are included at full precision because this is the account
    holder's own data and they asked for it. Nothing here is derived or
    embellished: every field is the stored value.
    """
    user = require_user()
    dbp = db_path()
    incidents = repo.list_incidents(dbp, user["id"], limit=1000)
    payload = {
        "exportedAt": iso(),
        "account": {
            "name": user.get("name"),
            "email": user.get("email"),
            "phone": user.get("phone"),
            "createdAt": user.get("created_at"),
        },
        "contacts": [public_contact(c) for c in repo.list_contacts(dbp, user["id"])],
        "incidents": [serialize_incident(i, include_events=True, dbp=dbp) for i in incidents],
        "journeys": [serialize_journey(j) for j in repo.list_journeys(dbp, user["id"], limit=1000)],
        "checkIns": repo.list_check_ins(dbp, user["id"], limit=1000),
        "communityReports": [
            serialize_report(r)
            for r in repo.list_reports(
                dbp,
                states=("COMMUNITY_REPORTED", "UNDER_REVIEW", "VERIFIED", "DISMISSED", "RESOLVED"),
                limit=1000,
            )
            if r.get("user_id") == user["id"]
        ],
        "rowCounts": repo.user_row_counts(dbp, user["id"]),
        "disclaimer": (
            "This export contains precise coordinates and phone numbers. Store it somewhere safe. "
            "SheSafe does not contact emergency services."
        ),
    }
    audit(
        dbp,
        action="privacy.export",
        outcome="success",
        actor_id=user["id"],
        detail={"incidents": len(payload["incidents"])},
        **audit_kwargs(),
    )
    return ok({"export": payload})


@bp.post("/privacy/cleanup")
@rate_limit("write")
@login_required
def cleanup():
    """Run the retention job immediately.

    The purge is table-wide: it trims expired share tokens, old location samples
    and old audit rows for *every* account, and closes stale emergencies. That
    makes it an operator action, not a personal one, so it is gated on the same
    moderator role that ``reports.moderate`` uses. It used to be reachable by any
    signed-in account, which let a stranger destroy another user's records and
    silently stand down their open incident.

    Demo Mode keeps it open to the demo identity so the retention story can be
    shown on stage; production never does.
    """
    user = require_user()
    dbp = db_path()
    if not _may_run_retention(user):
        audit(
            dbp,
            action="privacy.cleanup",
            outcome="denied",
            actor_id=user["id"],
            detail={"reason": "not_an_operator", "role": user.get("role", "user")},
            **audit_kwargs(),
        )
        raise AuthorizationError(
            "Running the retention job is an operator action.", code="operator_required"
        )
    cfg = current_app.config
    result = {
        "expiredShareTokens": repo.purge_expired_share_tokens(dbp),
        "oldLocationSamples": repo.purge_old_locations(dbp, int(cfg["INCIDENT_LOCATION_RETENTION_DAYS"])),
        "auditRows": repo.trim_audit_log(dbp, int(cfg["AUDIT_RETENTION_DAYS"])),
        "staleIncidentsClosed": repo.purge_stale_emergency_state(dbp, int(cfg["STALE_INCIDENT_MAX_HOURS"])),
    }
    audit(dbp, action="privacy.cleanup", outcome="success", detail=result, **audit_kwargs())
    log_event("privacy.cleanup", **result)
    return ok({"cleaned": result, "report": repo.retention_report(dbp, dict(cfg))})


@bp.delete("/account")
@rate_limit("auth")
@login_required
def delete_account():
    """Delete the account and everything that identifies the person.

    Requires an explicit typed confirmation, is irreversible, and is audited. The
    account is soft-deleted first, so the session stops working immediately even
    though the incident rows are being anonymised in the same request.
    """
    user = require_user()
    dbp = db_path()
    if current_app.config.get("ENV") == "production" and not current_app.config.get("ALLOW_ACCOUNT_DELETION", True):
        raise ServiceUnavailableError("Account deletion is disabled on this deployment.", code="deletion_disabled")

    body = request.get_json(silent=True) or {}
    confirmation = str(body.get("confirm") or "").strip().upper()
    if confirmation != "DELETE":
        raise ValidationError(
            'Type DELETE to confirm. This removes your account, contacts, location history and journeys.',
            confirm="required",
        )

    counts = repo.user_row_counts(dbp, user["id"])
    repo.soft_delete_user(dbp, user["id"])
    purged = repo.purge_user_personal_data(dbp, user["id"])

    audit(
        dbp,
        action="account.delete",
        outcome="success",
        actor_id=None,
        actor_label=None,
        detail={"rows": counts, "purged": purged},
        **audit_kwargs(),
    )
    log_event("account.deleted", user_id="deleted", **counts)
    return ok(
        {
            "deleted": True,
            "sessionRevoked": True,
            "removed": purged,
            "kept": {
                "incidentRecords": counts.get("incidents", 0),
                "note": "Incident rows are kept, without an owner, so the safety record is not silently rewritten. Coordinates, contact numbers and names in them are deleted.",
            },
        }
    )
