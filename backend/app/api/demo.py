"""Demo Mode.

Isolated behind an explicit server flag (``SHESAFE_DEMO_MODE=1``) and surfaced in
``/api/health`` and ``/api/capabilities``. When it is off, every route here
returns 404 - there is no way to reach Demo Mode by accident.

In Demo Mode:

* Every response carries ``demo: true`` and a ``demoNotice``.
* The places provider falls back to a clearly-labelled synthetic dataset so a
  judge demo never dead-ends without internet.
* SOS and journey flows behave exactly as in production - Demo Mode does not
  weaken the lifecycle, only the third-party data lookups.
* Nothing in Demo Mode ever claims to have contacted a real person or service.
"""

from __future__ import annotations

from flask import Blueprint, current_app

from ..errors import NotFoundError
from ..security import login_required, rate_limit, require_user
from .helpers import db_path, ok

bp = Blueprint("demo", __name__, url_prefix="/api/demo")

DEMO_NOTICE = (
    "DEMO MODE. Simulated data and simulations are labelled in the interface. "
    "No real emergency service, contact or police dispatch is involved."
)

SCRIPT = [
    {"step": 1, "id": "login", "title": "Sign in", "seconds": 15, "say": "One-click demo sign-in; sessions are real signed cookies."},
    {"step": 2, "id": "dashboard", "title": "Dashboard", "seconds": 20, "say": "SOS is the primary action. Everything else is secondary."},
    {"step": 3, "id": "sos", "title": "Trigger SOS", "seconds": 45, "say": "Cancel window, GPS fix with accuracy, incident reference, contact alert outcomes shown as SIMULATED."},
    {"step": 4, "id": "sharing", "title": "Live tracking", "seconds": 35, "say": "Open the guardian link in a second tab to show live position and revocation."},
    {"step": 5, "id": "cancel", "title": "Stand down", "seconds": 20, "say": "Resolve the incident; the record shows the full timeline."},
    {"step": 6, "id": "intelligence", "title": "Safety Intelligence", "seconds": 40, "say": "Point risk score with weighted features, confidence and provenance."},
    {"step": 7, "id": "routes", "title": "Safe routes", "seconds": 35, "say": "Fastest / safest / balanced with the reasoning shown."},
    {"step": 8, "id": "journey", "title": "Journey Guard", "seconds": 30, "say": "Start a 1-minute journey and show escalation to a real SOS incident."},
    {"step": 9, "id": "report", "title": "Incident report", "seconds": 25, "say": "Classification plus guidance; shows that AI never triggers SOS."},
    {"step": 10, "id": "security", "title": "Privacy & security", "seconds": 25, "say": "Expiring share tokens, scoped data, and the capability manifest."},
]


def _require_demo() -> None:
    if not current_app.config.get("DEMO_MODE"):
        raise NotFoundError("Demo mode is not enabled on this deployment.")


@bp.get("/script")
@rate_limit("read")
def script():
    _require_demo()
    return ok({"demo": True, "notice": DEMO_NOTICE, "script": SCRIPT, "totalSeconds": sum(s["seconds"] for s in SCRIPT)})


@bp.get("/status")
@rate_limit("read")
def status():
    return ok(
        {
            "demo": bool(current_app.config.get("DEMO_MODE")),
            "notice": DEMO_NOTICE if current_app.config.get("DEMO_MODE") else None,
        }
    )


@bp.post("/reset")
@rate_limit("write")
@login_required
def reset():
    """Wipe the demo account's generated data so a rehearsal can be repeated.

    Only touches the signed-in user's own rows.
    """
    _require_demo()
    from .. import repo

    user = require_user()
    dbp = db_path()
    incident = repo.find_active_incident(dbp, user["id"])
    if incident:
        repo.transition_incident(
            dbp,
            incident["id"],
            "CANCELLED",
            from_state=incident["state"],
            detail="demo reset",
            outcome="CANCELLED",
            resolution_note="Demo reset",
            resolved_at=repo.iso(),
        )
    journey = repo.active_journey(dbp, user["id"])
    if journey:
        repo.transition_journey(
            dbp, journey["id"], "CANCELLED", from_state=journey["state"], detail="demo reset", ended_at=repo.iso()
        )
    for token in repo.list_share_tokens(dbp, user["id"]):
        repo.revoke_share_token(dbp, user["id"], token["id"])
    return ok({"reset": True, "notice": DEMO_NOTICE})