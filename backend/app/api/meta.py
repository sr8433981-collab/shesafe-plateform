"""Health, capability report and Demo Mode.

``/api/health`` is also the **capability manifest**: it tells the frontend which
integrations are real, which are simulated and which are unavailable, so the UI
never has to guess and never has to hardcode a claim.
"""

from __future__ import annotations

from flask import Blueprint, current_app

from .. import db, repo, validation
from ..intelligence import scoring
from ..logging_utils import iso
from ..security import client_identity, ip_hash, rate_limit
from ..validation import require_json  # noqa: F401  (re-export convenience)
from .helpers import db_path, ok

bp = Blueprint("meta", __name__, url_prefix="/api")

OFFICIAL_HELPLINES = [
    {"number": "112", "title": "National Emergency Response (ERSS)", "category": "All-in-one", "icon": "siren", "note": "Police, fire and ambulance, single number."},
    {"number": "181", "title": "Women Helpline", "category": "Women safety", "icon": "women", "note": "24x7 support and legal aid for women in distress."},
    {"number": "100", "title": "Police Control Room", "category": "Police", "icon": "police", "note": "Direct police emergency number."},
    {"number": "108", "title": "Ambulance / Emergency Medical", "category": "Medical", "icon": "ambulance", "note": "Emergency medical transport."},
    {"number": "101", "title": "Fire and Rescue", "category": "Rescue", "icon": "fire", "note": "Fire and rescue services."},
    {"number": "1091", "title": "National Commission for Women", "category": "Women safety", "icon": "shield", "note": "Women in distress helpline."},
    {"number": "1098", "title": "Childline", "category": "Child protection", "icon": "child", "note": "24x7 child protection helpline."},
    {"number": "1930", "title": "Cyber Crime Helpline", "category": "Cyber safety", "icon": "cyber", "note": "Online harassment, stalking and financial fraud."},
]


@bp.get("/health")
@rate_limit("read")
def health():
    cfg = current_app.config
    registry = current_app.extensions.get("shesafe_notifications")
    dbp = db_path()
    counts = {
        table: (db.query_one(dbp, f"SELECT COUNT(*) AS c FROM {table}") or {"c": 0})["c"]
        for table in ("users", "contacts", "incidents", "journeys", "share_tokens", "community_reports")
    }
    return ok(
        {
            "status": "ok",
            "service": "SheSafe API",
            "version": "2.0.0",
            "environment": cfg.get("ENV", "development"),
            "demoMode": bool(cfg.get("DEMO_MODE")),
            "timestamp": iso(),
            "counts": counts,
        }
    )


@bp.get("/capabilities")
@rate_limit("read")
def capabilities():
    """What is real, what is simulated, what is unavailable.

    This endpoint is the single source of truth for every honesty label in the
    UI. Nothing is hardcoded in the frontend.
    """
    cfg = current_app.config
    registry = current_app.extensions.get("shesafe_notifications")
    notifications = registry.describe() if registry else []

    routing_provider = (cfg.get("ROUTING_PROVIDER") or "osrm").lower()
    places_provider = (cfg.get("PLACES_PROVIDER") or "overpass").lower()
    ai_provider = (cfg.get("AI_PROVIDER") or "none").lower()

    return ok(
        {
            "capabilities": [
                {
                    "id": "sos",
                    "label": "SOS emergency flow",
                    "mode": "real",
                    "detail": "Server-authoritative lifecycle with a durable audit trail. Works offline of any AI or third-party service.",
                },
                {
                    "id": "police_dispatch",
                    "label": "Police dispatch",
                    "mode": "unavailable",
                    "detail": "SheSafe does not contact police. The Call 112 button opens your phone's dialler; the call is placed by you.",
                },
                {
                    "id": "notifications",
                    "label": "Contact notifications",
                    "mode": "real" if any(n["mode"] == "real" for n in notifications) else "simulated",
                    "detail": "Providers are configured per channel. Without credentials, attempts are recorded as SIMULATED and labelled in the UI.",
                    "channels": notifications,
                },
                {
                    "id": "live_location",
                    "label": "Live location sharing",
                    "mode": "real",
                    "detail": "GPS via watchPosition, with expiring, revocable share links. Stops when the page is closed.",
                },
                {
                    "id": "risk_scoring",
                    "label": "Safety risk scoring",
                    "mode": "real",
                    "detail": f"{scoring.MODEL_VERSION}: transparent weighted rules with explainability. Not a trained ML model.",
                },
                {
                    "id": "routing",
                    "label": "Road routing",
                    "mode": "real" if routing_provider not in {"none", "unavailable"} else "unavailable",
                    "detail": (
                        "Real road geometry from the public OSRM service."
                        if routing_provider not in {"none", "unavailable"}
                        else "Routing disabled; only straight-line estimates are possible."
                    ),
                    "provider": routing_provider,
                },
                {
                    "id": "places",
                    "label": "Nearby safe places",
                    "mode": "real" if places_provider not in {"none", "unavailable"} else "unavailable",
                    "detail": (
                        "Crowd-maintained OpenStreetMap data via Overpass. Not an official endorsement of any venue."
                        if places_provider not in {"none", "unavailable"}
                        else "Place lookup disabled."
                    ),
                    "provider": places_provider,
                },
                {
                    "id": "journey_guard",
                    "label": "Journey Guard",
                    "mode": "real",
                    "detail": "State is stored server-side, but timers only advance while the page is open. Browsers cannot monitor reliably in the background.",
                },
                {
                    "id": "voice_sos",
                    "label": "Voice SOS",
                    "mode": "partial",
                    "detail": "Requires browser SpeechRecognition support and microphone permission. Always requires a confirmation tap; never dispatches silently.",
                },
                {
                    "id": "ai_incident_assist",
                    "label": "AI incident guidance",
                    "mode": "real" if ai_provider not in {"none", "unavailable"} else "simulated",
                    "detail": (
                        "An LLM provider is configured; output is advisory and unverified."
                        if ai_provider not in {"none", "unavailable"}
                        else "No AI provider configured, so the transparent rule-based classifier is used. SOS never depends on AI."
                    ),
                    "provider": ai_provider,
                },
                {
                    "id": "push",
                    "label": "Web push",
                    "mode": "partial",
                    "detail": "Requires a service worker and a configured FCM key. Off by default.",
                },
            ],
            "disclaimers": [
                "SheSafe has no government integration. Nothing here is a substitute for emergency services.",
                "Safety scores are rule-based estimates, not measured outcomes.",
                "Community reports are user submissions until reviewed.",
            ],
        }
    )


@bp.get("/helplines")
@rate_limit("read")
def helplines():
    return ok(
        {
            "helplines": OFFICIAL_HELPLINES,
            "note": "These are publicly published national helplines for India. Calling them is a user action on their own device.",
        }
    )


@bp.get("/meta/audit")
@rate_limit("read")
def audit_tail():
    """Recent audit entries (operator view). Requires a session.

    Deliberately does not expose precise coordinates: the audit writer already
    coarsens them.
    """
    from flask import g

    if not getattr(g, "user", None):
        from ..security import require_user

        require_user()
    dbp = db_path()
    rows = db.query(
        dbp,
        "SELECT action, outcome, target_type, target_id, request_id, detail, created_at "
        "FROM audit_log ORDER BY id DESC LIMIT 40",
    )
    return ok({"entries": db.rows_to_dicts(rows)})