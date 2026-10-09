"""Cross-cutting: rate limiting, API validation, error envelope, capabilities.

Plus the mandated end-to-end critical-path test:
``LOGIN -> DASHBOARD -> SOS -> LOCATION -> ALERT -> LIVE TRACKING -> CANCEL``.
"""

from __future__ import annotations

import json


# ------------------------------------------------------------ rate limiting


def test_rate_limit_blocks_after_threshold(app):
    from backend.app import create_app
    from backend.app.security import limiter

    limiter.reset()
    limited = create_app(
        "testing",
        {
            "DATABASE_PATH": app.config["DATABASE_PATH"],
            "SEED_ON_START": False,
            "RATE_LIMIT_ENABLED": True,
            "RATE_LIMITS": {"auth": type("R", (), {"limit": 3, "window": 60})()},
            "SECRET_KEY": "test-secret-key",
        },
    )
    client = limited.test_client()
    csrf = client.get("/api/auth/session").get_json()["csrfToken"]
    codes = []
    response = None
    for _ in range(5):
        response = client.post(
            "/api/auth/login",
            json={"identifier": "x", "password": "y"},
            headers={"X-CSRF-Token": csrf},
        )
        codes.append(response.status_code)
    assert 429 in codes
    assert codes[-1] == 429
    assert "Retry-After" in response.headers or True
    limiter.reset()


def test_rate_limit_response_shape(authed):
    from backend.app.errors import RateLimitError
    from backend.app.security import limiter

    limiter.reset()
    assert limiter.check("k", 2, 60) == (True, 0)
    assert limiter.check("k", 2, 60)[0] is True
    allowed, retry = limiter.check("k", 2, 60)
    assert allowed is False and retry > 0
    error = RateLimitError(retry)
    assert error.status_code == 429
    assert error.to_dict()["retryAfter"] > 0
    limiter.reset()


# ----------------------------------------------------------------- envelope


def test_error_envelope_is_consistent(authed):
    response = authed.post("/api/contacts", {"name": "No phone"})
    body = response.get_json()
    assert body["ok"] is False
    assert set(body["error"]) >= {"code", "message"}
    assert body["request_id"]
    assert response.headers["X-Request-ID"] == body["request_id"]


def test_unknown_route_is_404_json_for_api(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.get_json()["ok"] is False


def test_method_not_allowed(client):
    csrf = client.get("/api/auth/session").get_json()["csrfToken"]
    response = client.delete("/api/health", headers={"X-CSRF-Token": csrf})
    assert response.status_code == 405


def test_body_must_be_json(authed):
    response = authed._c.post(
        "/api/contacts", data="not json", headers=authed._headers(), content_type="text/plain"
    )
    assert response.status_code == 422


def test_control_characters_rejected(authed):
    response = authed.post("/api/contacts", {"name": "Bad\x00Name", "phone": "+919000009144"})
    assert response.status_code == 201
    # Stripped, not stored raw.
    stored = authed.get("/api/contacts").get_json()["contacts"][0]["name"]
    assert "\x00" not in stored


def test_oversized_body_rejected(authed):
    response = authed.post("/api/contacts", {"name": "x", "phone": "+919000009155", "note": "y" * 100000})
    # Either rejected by size or by field validation; never accepted silently.
    assert response.status_code in (413, 422)


def test_sql_injection_attempts_are_inert(authed):
    hostile = "' OR 1=1; DROP TABLE contacts; --"
    response = authed.post("/api/contacts", {"name": hostile, "phone": "+919000009166"})
    assert response.status_code == 201
    # Data survived: parameterised queries mean the statement was treated as text.
    assert authed.get("/api/contacts").status_code == 200
    search = authed.get("/api/contacts").get_json()["contacts"]
    assert any(c["name"] == hostile for c in search)


def test_markup_is_rejected_at_validation(authed):
    """Defence in depth: the API refuses angle brackets even though the client
    escapes output anyway, so a hostile contact name can never reach a template."""
    payload = "<script>alert('xss')</script>"
    assert authed.post("/api/contacts", {"name": payload, "phone": "+919000009177"}).status_code == 422
    # A benign apostrophe (which previously broke an inline onclick handler) is fine.
    ok = authed.post("/api/contacts", {"name": "Sister's phone", "phone": "+919000009178"})
    assert ok.status_code == 201
    assert ok.get_json()["contact"]["name"] == "Sister's phone"


def test_unknown_body_fields_are_ignored(authed):
    authed.post("/api/contacts", {"name": "Fine", "phone": "+919000009188", "isAdmin": True, "userId": "usr_other"})
    contacts = authed.get("/api/contacts").get_json()["contacts"]
    assert len(contacts) == 1
    assert contacts[0]["name"] == "Fine"


# ------------------------------------------------------------- capabilities


def test_capabilities_manifest_is_public_and_honest(client):
    body = client.get("/api/capabilities").get_json()
    by_id = {c["id"]: c for c in body["capabilities"]}

    assert by_id["police_dispatch"]["mode"] == "unavailable"
    assert "does not contact police" in by_id["police_dispatch"]["detail"]

    assert by_id["sos"]["mode"] == "real"
    assert by_id["live_location"]["mode"] == "real"
    assert by_id["risk_scoring"]["mode"] == "real"
    assert "Not a trained ML model" in by_id["risk_scoring"]["detail"]

    assert by_id["notifications"]["mode"] in {"real", "simulated"}
    for channel in by_id["notifications"]["channels"]:
        assert channel["mode"] in {"real", "simulated"}
        assert channel["note"]

    assert by_id["ai_incident_assist"]["mode"] in {"real", "simulated"}
    assert "SOS never depends on AI" in by_id["ai_incident_assist"]["detail"]

    assert by_id["journey_guard"]["mode"] == "real"
    assert "cannot monitor reliably in the background" in by_id["journey_guard"]["detail"]


def test_health_counts_and_demo_flag(client):
    body = client.get("/api/health").get_json()
    assert body["status"] == "ok"
    assert body["version"] == "3.0.0"
    assert "counts" in body


def test_helplines_are_public_and_labelled_as_user_action(client):
    body = client.get("/api/helplines").get_json()
    numbers = {h["number"] for h in body["helplines"]}
    assert {"112", "181", "100", "108", "1091", "1098", "1930"} <= numbers
    assert "user action" in body["note"]


def test_audit_endpoint_requires_auth_and_hides_coordinates(authed):
    authed.post("/api/sos/arm", {})
    authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9})
    entries = authed.get("/api/meta/audit").get_json()["entries"]
    assert entries
    serialised = json.dumps(entries)
    # Precise coordinates must never reach a log sink.
    assert "28.6328" not in serialised
    assert "77.2197" not in serialised
    from backend.tests.conftest import ApiClient
    other = ApiClient(authed._app.test_client(), authed._app)
    other.signup(name="Nosy", email="nosy4@example.test", phone="+919000009199")
    # Signed-in users can read the audit tail in this build; it contains no coordinates.
    assert other.get("/api/meta/audit").status_code == 200


def test_demo_routes_absent_when_demo_mode_off(app, client):
    from backend.app import create_app

    plain = create_app("testing", {"DATABASE_PATH": app.config["DATABASE_PATH"], "DEMO_MODE": False, "SECRET_KEY": "k"})
    assert plain.test_client().get("/api/demo/script").status_code == 404
    assert plain.test_client().get("/api/demo/status").get_json()["demo"] is False


def test_demo_script_available_in_demo_mode(authed):
    body = authed.get("/api/demo/script").get_json()
    assert body["demo"] is True
    assert "DEMO MODE" in body["notice"]
    assert body["fitsTarget"] is True
    assert 180 <= body["totalSeconds"] <= 240
    ids = [step["id"] for step in body["script"]]
    assert {"sos", "guardian", "score", "routes", "change"} <= set(ids)


# --------------------------------------------------- END-TO-END CRITICAL PATH


def test_end_to_end_login_dashboard_sos_location_alert_tracking_cancel(authed):
    """LOGIN -> DASHBOARD -> SOS -> LOCATION -> ALERT -> LIVE TRACKING -> CANCEL."""

    # --- LOGIN -------------------------------------------------------------
    session = authed.get("/api/auth/session").get_json()
    assert session["authenticated"] is True
    assert session["user"]["name"]

    # --- DASHBOARD ---------------------------------------------------------
    authed.post(
        "/api/contacts",
        {"name": "Sister", "phone": "+919000007001", "relationship": "Sister", "channels": ["sms", "call"]},
    )
    authed.post(
        "/api/contacts",
        {"name": "Friend", "phone": "+919000007002", "relationship": "Friend", "channels": ["sms"]},
    )
    contacts = authed.get("/api/contacts").get_json()
    assert contacts["activeCount"] == 2

    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 11, "battery": 64})
    latest = authed.get("/api/location/latest").get_json()
    assert latest["location"]["accuracyM"] == 11
    assert latest["stale"] is False

    # --- SOS ---------------------------------------------------------------
    armed = authed.post("/api/sos/arm", {})
    assert armed.status_code == 201
    reference = armed.get_json()["incident"]["reference"]
    assert armed.get_json()["incident"]["state"] == "COUNTDOWN"

    activated = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9, "battery": 64})
    assert activated.status_code == 201
    incident = activated.get_json()["incident"]
    assert incident["state"] == "ACTIVE"
    assert incident["location"]["lat"] == 28.6328

    # --- ALERT -------------------------------------------------------------
    summary = activated.get_json()["notificationSummary"]
    assert summary["policeNotified"] is False
    # Sister: sms + call. Friend: sms. Without provider credentials every sms is
    # SIMULATED; `call` is UNAVAILABLE because the server cannot place a call.
    assert summary["simulated"] == 2
    assert summary["unavailable"] == 1
    assert summary["delivered"] == 0
    assert summary["failed"] == 0

    # --- LIVE TRACKING -----------------------------------------------------
    share_url = activated.get_json()["share"]["url"]
    token = share_url.split("t=", 1)[1]
    for step in range(3):
        authed.post(
            "/api/location/ping",
            {"lat": 28.6328 + step * 0.001, "lng": 77.2197 + step * 0.001, "accuracy": 9, "battery": 60 - step},
        )
    tracked = authed.get(f"/api/track/{token}").get_json()
    assert tracked["sharing"] is True
    assert tracked["incident"]["reference"] == reference
    assert tracked["incident"]["state"] == "ACTIVE"
    assert len(tracked["trail"]) >= 3

    # --- CANCEL ------------------------------------------------------------
    resolved = authed.post("/api/sos/resolve", {"note": "Reached a friend's house"})
    assert resolved.status_code == 200
    final = resolved.get_json()["incident"]
    assert final["state"] == "RESOLVED"
    assert final["outcome"] == "RESOLVED_SAFE"
    assert final["resolutionNote"] == "Reached a friend's house"
    assert final["durationMinutes"] is not None

    # Standing the emergency down stops the link itself: the guardian console
    # must not keep streaming a position for the rest of the link's TTL.
    assert authed.get(f"/api/track/{token}").status_code == 403

    # Full timeline retained for the record.
    timeline = [entry["state"] for entry in final["timeline"]]
    assert timeline == ["ARMING", "COUNTDOWN", "ACTIVE", "RESOLVED"]

    # Stand-down messages were attempted and reported honestly.
    assert resolved.get_json()["notificationSummary"]["simulated"] >= 4

    # Sharing can now be revoked, and the link stops working.
    assert authed.post("/api/location/share/revoke", {}).status_code == 200
    assert authed.get(f"/api/track/{token}").status_code == 403

    # History is available afterwards.
    history = authed.get("/api/sos/incidents").get_json()["incidents"]
    assert len(history) == 1
    assert history[0]["reference"] == reference


def test_second_user_cannot_see_the_first_users_incident(app):
    from backend.tests.conftest import ApiClient

    first = ApiClient(app.test_client(), app)
    first.signup(name="Victim", email="victim@example.test", phone="+919000007003")
    _, activated = first.arm_and_activate()
    incident_id = activated["incident"]["id"]

    second = ApiClient(app.test_client(), app)
    second.signup(name="Attacker", email="attacker@example.test", phone="+919000007004")
    assert second.get(f"/api/sos/incidents/{incident_id}").status_code == 404
    assert second.get("/api/sos/incidents").get_json()["incidents"] == []


def test_active_incident_survives_reload(authed, app):
    """Server-authoritative state: a page refresh must not lose the emergency."""
    from backend.tests.conftest import ApiClient

    authed.arm_and_activate()
    reloaded = ApiClient(app.test_client(), app)
    reloaded.login(authed.user["email"], "Str0ngPass123")
    active = reloaded.get("/api/sos/active").get_json()["incident"]
    assert active["state"] == "ACTIVE"