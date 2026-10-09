"""Release-candidate regression tests.

Every test here corresponds to a defect reproduced on a clean checkout of the
release candidate and then fixed. They are grouped by the promise that was
broken, and each one names the failure in its docstring so a future reader can
tell what regressed without reading the git history.

* Directionality - a route must never claim it passes *closer* to help when the
  nearest facility is far away.
* Tenant isolation - incident data, the audit tail and the retention purge must
  never cross accounts.
* Alert honesty - a notification provider that raises must leave a recorded
  ``failed`` attempt, not an open emergency with nobody told and no trace.
* Production posture - production must never come up in demo mode or with the
  documented demo account seeded.
"""

from __future__ import annotations

import pytest

from conftest import ApiClient

DELHI = {"lat": 28.6328, "lng": 77.2197}


def _other_account(app, name, email, phone):
    """A second account with its own cookie jar (the `client` fixture is shared)."""
    return ApiClient(app.test_client(), app)


# ------------------------------------------------- directionality of a route


def test_route_never_claims_help_is_closer_when_it_is_far(app):
    """Regression: the route explanation was inverted.

    ``safety_infrastructure.value`` is *risk*, defined as ``1 - helpfulness``.
    The "passes closer to police, hospital or support facilities" line was gated
    on ``value > 0.55``, which is the low-helpfulness case: it fired precisely
    when the nearest facility was far away, and stayed silent when a station was
    50 m from the route.
    """
    from backend.app.intelligence import scoring
    from backend.app.intelligence import _why_text

    # A facility 50 m away: helpfulness is high, so risk value is LOW.
    close = scoring.assess(
        lat=DELHI["lat"],
        lng=DELHI["lng"],
        hour_local=2,
        incidents=[],
        places=[
            {"name": "City Police Station", "category": "police", "distance_km": 0.05, "lat": DELHI["lat"], "lng": DELHI["lng"]},
        ],
        reports=[],
    )
    infra_close = next(f for f in close.features if f.key == "safety_infrastructure")
    assert infra_close.observed is True
    assert infra_close.value < 0.55, f"a 50 m police station should be low risk, got {infra_close.value}"

    # No facility within reach: helpfulness is 0, so risk value is HIGH.
    far = scoring.assess(
        lat=DELHI["lat"], lng=DELHI["lng"], hour_local=2, incidents=[],
        places=[{"name": "Distant clinic", "category": "hospital", "distance_km": 40.0,
                 "lat": DELHI["lat"], "lng": DELHI["lng"]}],
        reports=[],
    )
    infra_far = next(f for f in far.features if f.key == "safety_infrastructure")
    assert infra_far.value > 0.55, f"a 40 km clinic should be high risk, got {infra_far.value}"

    lines_close = _why_text(close, close, 0, "osrm")
    lines_far = _why_text(far, far, 1, "osrm")
    assert any("Passes closer to" in line for line in lines_close), (
        f"a route beside a police station should say help is closer, got {lines_close}"
    )
    assert not any("Passes closer to" in line for line in lines_far), (
        f"a route with the nearest facility 40 km away must NOT claim help is closer, got {lines_far}"
    )


# ------------------------------------------------------------ tenant isolation


def test_incident_density_never_leaks_another_users_incident(app, client):
    """Regression: the incident-density feature read the whole incidents table.

    Any signed-in account could grid-probe coordinates and read back another
    user's emergency location as an ``observations`` count, which pinpointed
    where a real SOS had been raised.
    """
    victim = _other_account(app, "Victim", "victim@example.test", "+919000000101")
    victim.signup(name="Victim", email="victim@example.test", phone="+919000000101")
    victim.arm_and_activate()

    attacker = _other_account(app, "Attacker", "attacker@example.test", "+919000000102")
    attacker.signup(name="Attacker", email="attacker@example.test", phone="+919000000102")
    assert attacker.get("/api/sos/incidents").get_json()["incidents"] == []

    def density(api, lat):
        body = api.get(f"/api/intelligence/assess?lat={lat}&lng={DELHI['lng']}&radiusKm=0.3").get_json()
        feature = next(f for f in body["assessment"]["features"] if f["key"] == "incident_density")
        return feature["observations"]

    assert density(attacker, DELHI["lat"]) == 0, (
        "a user with no incidents of their own must not observe another user's emergency"
    )
    # The feature must still work on the user's own records.
    assert density(victim, DELHI["lat"]) == 1, "a user must still see their own incident history"


def test_audit_tail_is_scoped_to_the_caller(app, client):
    """Regression: ``GET /api/meta/audit`` returned the tail of the whole table.

    Any registered account could read every other user's incident ids, contact
    ids and timestamps.
    """
    victim = _other_account(app, "Victim", "victim@example.test", "+919000000103")
    victim.signup(name="Victim", email="victim@example.test", phone="+919000000103")
    victim.arm_and_activate()

    attacker = _other_account(app, "Attacker", "attacker@example.test", phone="+919000000104")
    attacker.signup(name="Attacker", email="attacker@example.test", phone="+919000000104")

    body = attacker.get("/api/meta/audit").get_json()
    actions = {entry["action"] for entry in body["entries"]}
    assert "sos.arm" not in actions and "sos.activate" not in actions, (
        f"the audit tail leaked another account's SOS events: {sorted(actions)}"
    )
    # The caller still sees their own trail.
    assert "auth.signup" in actions


def test_retention_purge_is_not_reachable_by_a_normal_account(app, client):
    """Regression: ``POST /api/privacy/cleanup`` was callable by any account.

    The purge is table-wide, so a stranger could delete other users' location
    samples and close their open incidents.
    """
    from backend.app import create_app

    strict = create_app(
        "testing",
        {
            "DATABASE_PATH": app.config["DATABASE_PATH"],
            "SEED_ON_START": False,
            "RATE_LIMIT_ENABLED": False,
            "DEMO_MODE": False,
            "SECRET_KEY": "k",
        },
    )
    api = ApiClient(strict.test_client(), strict)
    api.signup(name="Regular", email="regular@example.test", phone="+919000000105")
    response = api.post("/api/privacy/cleanup")
    assert response.status_code == 403, response.get_json()
    assert response.get_json()["error"]["code"] == "operator_required"


def test_moderator_may_still_run_the_retention_purge(app, client):
    """The operator gate must not lock operators out."""
    from backend.app import db

    strict_db = app.config["DATABASE_PATH"]
    operator = _other_account(app, "Ops", "ops@example.test", "+919000000106")
    operator.signup(name="Ops", email="ops@example.test", phone="+919000000106")
    db.query(
        strict_db,
        "UPDATE users SET role = 'moderator' WHERE email = ?",
        ("ops@example.test",),
    )
    # The session must be re-established so the role change is picked up.
    operator.reauthenticate()
    assert operator.post("/api/privacy/cleanup").status_code == 200


# ------------------------------------------------------------- alert honesty


def test_provider_exception_leaves_a_recorded_failed_attempt(app, client, monkeypatch):
    """Regression: a raising provider produced a 500 and no record at all.

    ``_notify_contacts`` runs after the incident is already ACTIVE and the share
    token is minted. An exception used to abort the request with a 500, leaving
    an open emergency that had alerted nobody, no ``notification_attempts`` row,
    and a retry that was then suppressed as a duplicate. Every attempt is now
    recorded, and the remaining contacts are still alerted.
    """
    api = ApiClient(app.test_client(), app)
    api.signup(name="Sender", email="sender@example.test", phone="+919000000107")
    api.post("/api/contacts", {"name": "Mom", "phone": "+919111111118", "channels": ["sms"]})
    api.post("/api/contacts", {"name": "Bro", "phone": "+919222222229", "channels": ["sms"]})
    api.post("/api/sos/arm", {})

    registry = app.extensions["shesafe_notifications"]
    attempts = {"n": 0}

    def explode(*_args, **_kwargs):
        attempts["n"] += 1
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(registry.get("sms"), "send", explode, raising=False)

    response = api.post("/api/sos/activate", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    assert response.status_code == 201, response.get_json()

    summary = response.get_json()["notificationSummary"]
    assert summary["failed"] == 2, summary
    assert summary["delivered"] == 0, summary
    assert attempts["n"] == 2, "every contact must still be attempted after one raises"

    active = api.get("/api/sos/active").get_json()["incident"]
    assert active["state"] == "ACTIVE"
    assert active["notificationSummary"]["failed"] == 2
    assert active["notificationSummary"]["delivered"] == 0


def test_one_failing_contact_does_not_stop_the_others(app, client, monkeypatch):
    """A single bad destination must not abandon the remaining contacts."""
    api = ApiClient(app.test_client(), app)
    api.signup(name="Sender", email="sender2@example.test", phone="+919000000108")
    api.post("/api/contacts", {"name": "Mom", "phone": "+919111111119", "channels": ["sms"]})
    api.post("/api/contacts", {"name": "Bro", "phone": "+919222222230", "channels": ["sms"]})
    api.post("/api/sos/arm", {})

    registry = app.extensions["shesafe_notifications"]
    provider = registry.get("sms")
    original = type(provider).send

    def selective(phone, body, context):
        if phone == "+919111111119":
            raise OSError("network down")
        return original(provider, phone, body, context)

    monkeypatch.setattr(provider, "send", selective, raising=False)
    response = api.post("/api/sos/activate", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    assert response.status_code == 201, response.get_json()
    summary = response.get_json()["notificationSummary"]
    assert summary["failed"] == 1, summary
    assert summary["unavailable"] + summary["simulated"] + summary.get("sent", 0) >= 1, summary


def test_failing_provider_cannot_turn_stand_down_into_a_500(app, client, monkeypatch):
    """The stand-down follow-up message uses the same guard.

    A provider that raised during the "I'm safe" broadcast used to abort the
    request after the incident was already RESOLVED, so a successful stand-down
    looked like a failure to the user and left no record of the attempt.
    """
    api = ApiClient(app.test_client(), app)
    api.signup(name="Sender", email="sender3@example.test", phone="+919000000110")
    api.post("/api/contacts", {"name": "Mom", "phone": "+919111111121", "channels": ["sms"]})
    api.arm_and_activate()

    registry = app.extensions["shesafe_notifications"]

    def explode(*_args, **_kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(registry.get("sms"), "send", explode, raising=False)

    response = api.post("/api/sos/resolve", {"outcome": "RESOLVED_SAFE", "note": "safe"})
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["incident"]["state"] == "RESOLVED"
    assert response.get_json()["notificationSummary"]["failed"] >= 1


# --------------------------------------------------------- production posture


def test_production_refuses_demo_mode_and_seeding(monkeypatch):
    """Regression: production inherited ``DEMO_MODE`` and ``SEED_ON_START``.

    ``SEED_ON_START`` defaults to True, so every production boot seeded
    ``demo@shesafe.local`` with the password ``shesafe-demo`` that is printed in
    the README and hard-coded into the sign-in form. ``SHESAFE_DEMO_MODE=1``
    additionally exposed ``/api/demo/reset`` to any signed-in account.
    """
    import importlib

    from backend.app import config as config_mod

    monkeypatch.setenv("SHESAFE_ENV", "production")
    monkeypatch.setenv("SHESAFE_DEMO_MODE", "1")
    monkeypatch.setenv("SHESAFE_SEED", "1")
    reloaded = importlib.reload(config_mod)
    try:
        production = reloaded.CONFIGS["production"]
        assert production.DEMO_MODE is False, "production must not run in demo mode"
        assert production.SEED_ON_START is False, "production must not seed the demo account"
    finally:
        monkeypatch.undo()
        importlib.reload(config_mod)


def test_documented_demo_still_runs_in_development(monkeypatch):
    """The judge demo runs with SHESAFE_DEMO_MODE=1 and no SHESAFE_ENV."""
    import importlib

    from backend.app import config as config_mod

    monkeypatch.setenv("SHESAFE_ENV", "development")
    monkeypatch.setenv("SHESAFE_DEMO_MODE", "1")
    reloaded = importlib.reload(config_mod)
    try:
        assert reloaded.CONFIGS["development"].DEMO_MODE is True
    finally:
        monkeypatch.undo()
        importlib.reload(config_mod)


def test_development_secret_key_uses_cross_platform_hostname(monkeypatch):
    """Development keys must not depend on Unix-only ``os.uname()``."""
    import os

    from backend.app import config as config_mod

    monkeypatch.delattr(os, "uname", raising=False)

    class DevConfig:
        ENV = "development"
        TESTING = False
        SECRET_KEY = ""

    key = config_mod.resolve_secret_key(DevConfig)
    assert isinstance(key, str)
    assert len(key) == 64


# ------------------------------------------------- stand-down stops sharing


@pytest.mark.parametrize("endpoint,payload", [
    ("/api/sos/resolve", {"outcome": "RESOLVED_SAFE", "note": "safe"}),
    ("/api/sos/cancel", {"reason": "false alarm"}),
])
def test_standing_down_revokes_the_incident_share_link(app, client, endpoint, payload):
    """Regression: the guardian link stayed live after stand-down.

    ``activate`` mints a share link scoped to the incident with a one-hour TTL.
    Neither ``resolve`` nor ``cancel`` revoked it, so after the user stood the
    emergency down the guardian console still answered 200 with
    ``linkState: "live"`` and ``sharing: true`` - the position kept streaming to
    anyone holding the link for another hour.
    """
    import re

    api = ApiClient(app.test_client(), app)
    api.signup(name="Sharer", email="sharer@example.test", phone="+919000000109")
    api.post("/api/contacts", {"name": "Mom", "phone": "+919111111120", "channels": ["sms"]})

    # Raise a real emergency so the link is scoped to an open incident, the way
    # activate() mints it.
    api.arm_and_activate()
    share = api.post("/api/location/share/start", {"ttlMinutes": 60}).get_json()
    raw = re.search(r"t=(shr_[A-Za-z0-9_-]+)", share["shareUrl"]).group(1)

    guest = app.test_client()
    live = guest.get(f"/api/track/{raw}").get_json()
    assert live["linkState"] == "live", f"precondition: the link should start live, got {live.get('linkState')}"

    api.post(endpoint, payload)

    assert guest.get(f"/api/track/{raw}").status_code == 403
    active = api.get("/api/location/share/active").get_json()
    assert all(s["status"] != "active" for s in active["shares"]), active["shares"]
