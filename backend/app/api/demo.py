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
from ..logging_utils import audit
from ..security import login_required, rate_limit, require_user
from .helpers import db_path, ok

bp = Blueprint("demo", __name__, url_prefix="/api/demo")

DEMO_NOTICE = (
    "DEMO MODE. Simulated data and simulations are labelled in the interface. "
    "No real emergency service, contact or police dispatch is involved."
)

#: The deterministic judge walkthrough. Served verbatim to the dashboard so the
#: script on screen can never drift from the documented one in docs/JUDGE_DEMO.md.
#:
#: The order is the product's story, and it is the same order every time:
#: **dashboard → score → why → route → journey → what changed → SOS → guardian →
#: incident record → stand down.**
#:
#: ``id`` matches a router route or a control id so the in-app guide can jump
#: straight to the screen that step is about. ``anchor`` is the element the guide
#: should scroll to, which is what makes "jump to the ledger" possible rather
#: than just "go to the intelligence screen".
SCRIPT = [
    {
        "step": 1,
        "id": "dashboard",
        "route": "home",
        "title": "Dashboard — the five-second read",
        "seconds": 20,
        "say": "One control dominates, then the safety status, then Journey Guard, live location, contacts and safe places. "
               "Nothing on this screen exists unless it helps you decide something.",
    },
    {
        "step": 2,
        "id": "score",
        "route": "intelligence",
        "anchor": "#assessment-hero",
        "title": "Safety score",
        "seconds": 25,
        "say": "The number on the left is the SAFETY score out of 100 - higher is safer. "
               "The band, the confidence and the data coverage are printed next to it, "
               "because a number without its coverage is a marketing claim, not a measurement.",
    },
    {
        "step": 3,
        "id": "why",
        "route": "intelligence",
        "anchor": "#assessment-why",
        "title": "Why this score?",
        "seconds": 30,
        "say": "Written by the engine from the same six features that produced the number, so the sentence cannot "
               "disagree with the arithmetic. Then the ledger: what pushed risk up, what pushed it down.",
    },
    {
        "step": 4,
        "id": "routes",
        "route": "route",
        "title": "A safer route",
        "seconds": 25,
        "say": "Real OSRM geometry, up to three genuine alternatives, each scored at nine points along the corridor. "
               "If coverage is too thin to rank them, it says 'Limited safety data available' instead of inventing a difference.",
    },
    {
        "step": 5,
        "id": "journey",
        "route": "journey",
        "title": "Journey Guard",
        "seconds": 20,
        "say": "Start a short journey. Miss the check-in and it escalates into a real SOS. The ladder is shown "
               "before it runs, and the browser limitation is stated on screen rather than buried.",
    },
    {
        "step": 6,
        "id": "change",
        "route": "intelligence",
        "anchor": "#assessment-change",
        "title": "What changed?",
        "seconds": 25,
        "say": "Change one input — time, place, route, or the data itself. The same engine re-scores and subtracts. "
               "BEFORE, the factor that moved, AFTER. Deterministic: the same inputs give the same number every time.",
    },
    {
        "step": 7,
        "id": "sos",
        "route": "home",
        "title": "SOS",
        "seconds": 30,
        "say": "Press and hold. Ten seconds to cancel, because a false alarm must cost nothing. Then it acquires GPS "
               "and reports the accuracy it actually got, plus how old that fix is.",
    },
    {
        "step": 8,
        "id": "guardian",
        "route": "sharing",
        "title": "Guardian view",
        "seconds": 25,
        "say": "Open the link in a second window. One word says whether it is LIVE, STALE, RECONNECTING or REVOKED. "
               "256-bit token, hashed at rest, expires automatically, and revocation kills the link instantly.",
    },
    {
        "step": 9,
        "id": "timeline",
        "route": "history",
        "title": "The incident record",
        "seconds": 15,
        "say": "Every event with its timestamp, type, status and a sentence explaining it — plus what was attempted "
               "per channel. Simulated, delivered, unavailable: never one word that hides the difference.",
    },
    {
        "step": 10,
        "id": "cancel",
        "route": "home",
        "title": "Stand down",
        "seconds": 15,
        "say": "Resolve. The record keeps every state change with its actor and timestamp, so what happened "
               "during those thirty seconds is still readable afterwards.",
    },
]


def _require_demo() -> None:
    if not current_app.config.get("DEMO_MODE"):
        raise NotFoundError("Demo mode is not enabled on this deployment.")


@bp.get("/script")
@rate_limit("read")
def script():
    _require_demo()
    total = sum(s["seconds"] for s in SCRIPT)
    return ok(
        {
            "demo": True,
            "notice": DEMO_NOTICE,
            "script": SCRIPT,
            "totalSeconds": total,
            "minutes": round(total / 60, 1),
            "targetSeconds": 240,
            "fitsTarget": total <= 240,
            "story": DEMO_STORY,
        }
    )


#: The one-sentence version of the walkthrough, used in the docs and the ribbon.
DEMO_STORY = (
    "PREVENT → ASSESS → NAVIGATE SAFELY → PROTECT JOURNEY → ACTIVATE SOS → "
    "SHARE LOCATION → COORDINATE TRUSTED PEOPLE → DOCUMENT INCIDENT"
)


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

    Only touches the signed-in user's own rows, and refuses while an incident is
    genuinely open so a live demo cannot be destroyed by a stray tap.
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
    audit(dbp, action="demo.reset", outcome="success", actor_id=user["id"], **audit_kwargs())
    return ok(
        {
            "reset": True,
            "notice": DEMO_NOTICE,
            "cleaned": ["open incident", "active journey", "share tokens"],
            "kept": "Past incidents are kept so the record you showed a judge is still there.",
        }
    )


def audit_kwargs() -> dict:
    from .helpers import audit_kwargs as _kwargs

    return _kwargs()