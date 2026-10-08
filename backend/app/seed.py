"""First-run seed.

Everything created here is **synthetic demo data**. There are no real names,
no real phone numbers and no real business records in this file. Phone numbers
use the reserved ``+91 90000 xxxxx`` block for Indian fiction numbers.

Seeding is idempotent: it only inserts when a table is empty.
"""

from __future__ import annotations

from . import db, repo
from .logging_utils import iso, log_event
from .security import hash_password

DEMO_EMAIL = "demo@shesafe.local"
DEMO_PHONE = "+919000000001"


def ensure_seed(db_path, config) -> None:
    """Create the demo account and reference helplines if nothing exists."""
    existing = db.query_one(db_path, "SELECT id FROM users LIMIT 1")
    if existing is not None:
        return

    password = config.get("SEED_DEMO_USER_PASSWORD", "shesafe-demo")
    user = repo.create_user(
        db_path,
        {
            "name": "Aarohi Demo",
            "email": DEMO_EMAIL,
            "phone": DEMO_PHONE,
            "blood_group": "B+",
            "emergency_notes": "Demo account. Add your own medical notes.",
            "home_area": "Demo area",
            "location_consent": True,
            "siren_enabled": True,
            "voice_sos_enabled": False,
        },
        hash_password(password),
    )
    for name, relation, phone, primary in (
        ("Demo Guardian 1", "Sister", "+919000000002", True),
        ("Demo Guardian 2", "Friend", "+919000000003", False),
    ):
        repo.create_contact(
            db_path,
            user["id"],
            {
                "name": name,
                "relationship": relation,
                "phone": phone,
                "channels": ["sms", "call"],
                "is_primary": primary,
                "verified": False,
                "active": True,
            },
        )

    _seed_reports(db_path, user["id"])
    log_event("seed.completed", user_id=user["id"], demo_mode=bool(config.get("DEMO_MODE")))


def _seed_reports(db_path, user_id: str) -> None:
    """Two clearly-labelled community reports, both in COMMUNITY_REPORTED state."""
    if db.query_one(db_path, "SELECT id FROM community_reports LIMIT 1"):
        return
    for category, title, description, place in (
        (
            "unsafe_area",
            "Underpass lighting reported out (community report)",
            "Several residents reported the underpass lighting not working after 21:00. Unverified community report.",
            "Sector 18 underpass",
        ),
        (
            "eve_teasing",
            "Repeated comments near the bus queue (community report)",
            "Multiple people reported comments near the bus queue over three evenings. Unverified community report.",
            "City bus terminal, Gate 2",
        ),
    ):
        repo.create_report(
            db_path,
            {
                "user_id": user_id,
                "category": category,
                "title": title,
                "description": description,
                "place_label": place,
                "anonymous": False,
            },
        )


def seed_official_places(db_path) -> int:  # pragma: no cover - maintenance helper
    """Not used at runtime; kept so an operator can seed verified-only data.

    SheSafe deliberately ships **no** bundled business list, because a stale or
    wrong facility in an emergency is worse than an empty list. Nearby places
    come from OpenStreetMap at request time.
    """
    return 0