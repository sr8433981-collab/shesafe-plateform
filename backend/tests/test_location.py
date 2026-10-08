"""Live location, share tokens and guardian access control."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone


def test_ping_requires_authentication(client):
    response = client.post("/api/location/ping", json={"lat": 28.6328, "lng": 77.2197})
    # CSRF is checked before authentication, so an unauthenticated write is a 403.
    assert response.status_code in (401, 403)


def test_ping_records_and_returns_location(authed):
    response = authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 12, "battery": 76})
    assert response.status_code == 200
    latest = authed.get("/api/location/latest").get_json()
    assert latest["location"]["lat"] == 28.6328
    assert latest["location"]["batteryPct"] == 76
    assert latest["stale"] is False
    assert latest["ageSeconds"] >= 0


def test_ping_body_cannot_impersonate_another_user(authed, app):
    """The old API trusted a body-supplied userId."""
    response = authed.post(
        "/api/location/ping",
        {"userId": "usr_someone_else", "lat": 28.6328, "lng": 77.2197, "accuracy": 10},
    )
    assert response.status_code == 200
    latest = authed.get("/api/location/latest").get_json()
    assert latest["location"]["lat"] == 28.6328
    assert authed.user["id"] not in latest["location"]["source"]


def test_invalid_coordinates_rejected(authed):
    for payload in (
        {"lat": 200, "lng": 77.2},
        {"lat": 28.6, "lng": -200},
        {"lat": "abc", "lng": 77.2},
        {"lat": None, "lng": None},
        {},
    ):
        assert authed.post("/api/location/ping", payload).status_code == 422, payload


def test_very_imprecise_fix_rejected(authed):
    response = authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 4000})
    assert response.status_code == 422
    assert "too imprecise" in response.get_json()["error"]["message"]


def test_share_link_uses_high_entropy_token_and_no_user_id(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    result = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json()
    url = result["shareUrl"]
    assert "user=" not in url
    token = url.split("t=", 1)[1]
    # 256 bits of entropy, base64url encoded.
    assert len(token) >= 44
    assert re.fullmatch(r"[A-Za-z0-9_-]+", token)


def test_only_token_hash_is_stored(authed, app):
    from backend.app import repo

    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    url = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json()["shareUrl"]
    raw = url.split("t=", 1)[1]
    tokens = repo.list_share_tokens(app.config["DATABASE_PATH"], authed.user["id"])
    assert raw not in tokens[0]["token_hash"]
    assert len(tokens[0]["token_hash"]) == 64  # sha256 hex


def test_guardian_view_works_with_valid_token(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 8})
    url = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json()["shareUrl"]
    token = url.split("t=", 1)[1]
    response = authed.get(f"/api/track/{token}")
    assert response.status_code == 200
    body = response.get_json()
    assert body["location"]["lat"] == 28.6328
    assert body["sharing"] is True
    # The guardian must not receive the user's full phone number.
    assert body["subject"]["phone"].startswith("***")
    assert "Please sign in" not in body["subject"]["displayName"]


def test_guardian_view_rejects_unknown_token(client):
    assert client.get("/api/track/" + "z" * 40).status_code == 403


def test_guardian_view_rejects_short_token(client):
    assert client.get("/api/track/abc").status_code == 403


def test_guardian_view_rejects_predicted_user_id_url(client):
    """The old build used ?user=usr_sweta_01. That must be meaningless now."""
    assert client.get("/api/track/usr_sweta_01").status_code == 403
    assert client.get("/api/location/live/usr_sweta_01").status_code == 404


def test_expired_token_rejected(authed, app):
    from backend.app import repo

    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    url = authed.post("/api/location/share/start", {"ttlSeconds": 600}).get_json()["shareUrl"]
    token = url.split("t=", 1)[1]

    past = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
    db = app.config["DATABASE_PATH"]
    repo_list = repo.list_share_tokens(db, authed.user["id"])
    from backend.app import db as dbmod

    dbmod.execute(db, "UPDATE share_tokens SET expires_at = ? WHERE id = ?", (past, repo_list[0]["id"]))

    response = authed.get(f"/api/track/{token}")
    assert response.status_code == 403
    assert "expired" in response.get_json()["error"]["message"].lower()


def test_revoked_token_rejected(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    url = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json()["shareUrl"]
    token = url.split("t=", 1)[1]
    assert authed.get(f"/api/track/{token}").status_code == 200

    share_id = authed.get("/api/location/share/active").get_json()["shares"][0]["id"]
    assert authed.post("/api/location/share/revoke", {"shareId": share_id}).status_code == 200
    response = authed.get(f"/api/track/{token}")
    assert response.status_code == 403
    assert "revoked" in response.get_json()["error"]["message"].lower()


def test_revoke_all_shares(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    authed.post("/api/location/share/start", {"ttlSeconds": 900})
    authed.post("/api/location/share/start", {"ttlSeconds": 900})
    authed.post("/api/location/share/revoke", {})
    shares = authed.get("/api/location/share/active").get_json()["shares"]
    assert all(s["status"] == "revoked" for s in shares)


def test_cannot_revoke_another_users_share(authed, app):
    from backend.tests.conftest import ApiClient

    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    share_id = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json() and \
        authed.get("/api/location/share/active").get_json()["shares"][0]["id"]

    other = ApiClient(app.test_client(), app)
    other.signup(name="Attacker", email="attacker@example.test", phone="+919000002020")
    assert other.post("/api/location/share/revoke", {"shareId": share_id}).status_code == 404
    assert authed.get("/api/location/share/active").get_json()["shares"][0]["status"] == "active"


def test_share_ttl_is_bounded(authed):
    # Absurd and degenerate TTLs are rejected rather than silently accepted.
    assert authed.post("/api/location/share/start", {"ttlSeconds": 99_999_999}).status_code == 422
    assert authed.post("/api/location/share/start", {"ttlSeconds": 1}).status_code == 422
    result = authed.post("/api/location/share/start", {"ttlSeconds": 7200}).get_json()
    assert result["ttlSeconds"] == 7200
    assert result["ttlSeconds"] <= app_max_ttl()


def app_max_ttl() -> int:
    from backend.app.config import Config

    return int(Config.SHARE_TOKEN_MAX_TTL)


def test_incident_links_location_and_includes_trail(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009099", "channels": ["sms"]})
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    authed.post("/api/sos/arm", {})
    result = authed.post("/api/sos/activate", {"lat": 28.6329, "lng": 77.2198, "accuracy": 8}).get_json()
    authed.post("/api/location/ping", {"lat": 28.6335, "lng": 77.2205, "accuracy": 7})
    authed.post("/api/location/ping", {"lat": 28.6341, "lng": 77.2212, "accuracy": 6})

    token = result["share"]["url"].split("t=", 1)[1]
    tracked = authed.get(f"/api/track/{token}").get_json()
    assert tracked["incident"]["reference"] == result["incident"]["reference"]
    assert len(tracked["trail"]) >= 3
    assert tracked["trailIncluded"] is True


def test_trail_can_be_excluded(authed):
    authed.post("/api/sos/arm", {})
    authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9})
    authed.post("/api/location/ping", {"lat": 28.64, "lng": 77.23, "accuracy": 9})
    url = authed.post("/api/location/share/start", {"includeTrail": False, "ttlSeconds": 900}).get_json()["shareUrl"]
    token = url.split("t=", 1)[1]
    tracked = authed.get(f"/api/track/{token}").get_json()
    assert tracked["trail"] == []
    assert tracked["trailIncluded"] is False


def test_stale_location_is_flagged(authed, app):
    from backend.app import db as dbmod
    from backend.app.logging_utils import iso

    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    url = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json()["shareUrl"]
    old = iso(datetime.now(timezone.utc) - timedelta(minutes=30))
    dbmod.execute(app.config["DATABASE_PATH"], "UPDATE location_samples SET created_at = ?", (old,))

    tracked = authed.get(f"/api/track/{url.split('t=', 1)[1]}").get_json()
    assert tracked["sharing"] is False
    assert tracked["locationStale"] is True
    assert "not currently sending location" in tracked["disclaimer"]


def test_guardian_endpoint_needs_no_session(authed, app):
    """A guardian opens the link on a different device; no SheSafe account needed."""
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    url = authed.post("/api/location/share/start", {"ttlSeconds": 900}).get_json()["shareUrl"]
    token = url.split("t=", 1)[1]

    from backend.tests.conftest import ApiClient

    stranger = ApiClient(app.test_client(), app)
    assert stranger.get(f"/api/track/{token}").status_code == 200