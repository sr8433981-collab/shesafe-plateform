"""Authentication, authorization and session security."""

from __future__ import annotations


def test_signup_hashes_password_and_returns_user(authed, app):
    from backend.app import repo

    user = authed.user
    assert user["id"].startswith("usr_")
    assert "password" not in user
    assert "passwordHash" not in user

    stored = repo.get_user(app.config["DATABASE_PATH"], user["id"])
    assert stored["password_hash"] != "Str0ngPass123"
    assert stored["password_hash"].startswith("pbkdf2:")


def test_login_success_and_failure_are_indistinguishable_on_failure(authed):
    ok = authed.login(authed.user["email"], "Str0ngPass123")
    assert ok.status_code == 200
    assert ok.get_json()["user"]["id"] == authed.user["id"]

    wrong = authed.login(authed.user["email"], "not-the-password")
    assert wrong.status_code == 401
    unknown = authed.login("nobody@example.test", "Str0ngPass123")
    assert unknown.status_code == 401
    # Identical copy: the response must not disclose which accounts exist.
    assert wrong.get_json()["error"]["message"] == unknown.get_json()["error"]["message"]


def test_login_accepts_local_or_international_phone_format(api):
    api.signup(name="Phone Login", email="phone.login@example.test", phone="9000004321")

    assert api.login("9000004321", "Str0ngPass123").status_code == 200
    assert api.login("+91 90000-04321", "Str0ngPass123").status_code == 200


def test_no_name_substring_auth_bypass(api):
    """The old build logged anyone in whose identifier contained 'sweta'."""
    api.signup(name="Sweta Sharma", email="sweta@example.test", phone="+919000005555")
    response = api.post("/api/auth/login", {"identifier": "sweta", "password": "anything-at-all"})
    assert response.status_code == 401


def test_demo_bypass_is_absent(api):
    api.signup(name="Someone Else", email="other@example.test", phone="+919000009999")
    response = api.post("/api/auth/login", {"identifier": "demo", "password": "x"})
    assert response.status_code == 401


def test_weak_passwords_rejected(api):
    for weak in ("short", "password123", "abcdefgh", "12345678"):
        response = api.post(
            "/api/auth/signup",
            {"name": "Weak", "email": f"w{abs(hash(weak))}@example.test", "phone": f"+91900000{abs(hash(weak)) % 10000:04d}", "password": weak},
        )
        assert response.status_code == 422, (weak, response.get_json())


def test_duplicate_email_and_phone_rejected(authed, api):
    assert api.post("/api/auth/signup", {"name": "Dup", "email": authed.user["email"], "phone": "+919009999999", "password": "Str0ngPass123"}).status_code == 409


def test_invalid_email_and_phone_rejected(api):
    bad_email = api.post("/api/auth/signup", {"name": "X", "email": "not-an-email", "phone": "+919000001111", "password": "Str0ngPass123"})
    assert bad_email.status_code == 422
    bad_phone = api.post("/api/auth/signup", {"name": "Y", "email": "y@example.test", "phone": "12", "password": "Str0ngPass123"})
    assert bad_phone.status_code == 422


def test_protected_endpoints_require_authentication(client):
    for path in (
        "/api/contacts",
        "/api/sos/active",
        "/api/location/latest",
        "/api/intelligence/assess",
        "/api/journeys",
        "/api/reports",
        "/api/checkins",
        "/api/location/share/active",
    ):
        response = client.get(path)
        assert response.status_code == 401, (path, response.status_code)


def test_csrf_required_on_state_changing_requests(client, app):
    client.get("/api/auth/session")
    response = client.post("/api/auth/signup", json={"name": "NoCsrf", "phone": "+919000002222", "password": "Str0ngPass123"})
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "not_authorised"


def test_csrf_mismatch_rejected(api):
    response = api.post("/api/sos/arm", {}, headers={"X-CSRF-Token": "x" * 44})
    assert response.status_code == 403


def test_forged_session_cookie_rejected(client):
    client.set_cookie("shesafe_session", "usr_abcdefghijklmnopqrst", domain="localhost")
    assert client.get("/api/contacts").status_code == 401


def test_tampered_signed_cookie_rejected(client, authed):
    """The cookie payload is a user id; the signature is what makes it unforgeable."""
    jar = client._cookies
    entry = next(v for k, v in jar.items() if k[2] == "shesafe_session")
    mangled = entry.value[:-3] + ("aaa" if not entry.value.endswith("aaa") else "bbb")
    client.set_cookie("shesafe_session", mangled, domain="localhost", path="/")
    assert client.get("/api/contacts").status_code == 401


def test_session_cookie_is_httponly(client):
    response = client.post(
        "/api/auth/signup",
        json={"name": "Cookie Test", "email": "cookie@example.test", "phone": "+919000003333", "password": "Str0ngPass123"},
        headers={"X-CSRF-Token": client.get("/api/auth/session").get_json()["csrfToken"]},
    )
    headers = response.headers.getlist("Set-Cookie")
    session_cookie = next(h for h in headers if h.startswith("shesafe_session="))
    assert "HttpOnly" in session_cookie
    assert "SameSite=Lax" in session_cookie
    csrf_cookie = next(h for h in headers if h.startswith("shesafe_csrf="))
    # The CSRF cookie must be readable by JS; the session cookie must not.
    assert "HttpOnly" not in csrf_cookie


def test_security_headers_present(client):
    headers = client.get("/api/health").headers
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
    assert headers["Cache-Control"].startswith("no-store")


def test_untrusted_origin_write_rejected(client):
    csrf = client.get("/api/auth/session").get_json()["csrfToken"]
    response = client.post(
        "/api/auth/signup",
        json={"name": "Evil", "phone": "+919000004444", "password": "Str0ngPass123"},
        headers={"X-CSRF-Token": csrf, "Origin": "https://evil.example.com"},
    )
    assert response.status_code == 403


def test_cors_does_not_echo_untrusted_origin(client):
    response = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert "Access-Control-Allow-Origin" not in response.headers


def test_profile_update_is_scoped_and_validated(authed):
    ok = authed.patch("/api/auth/profile", {"bloodGroup": "O-", "emergencyNotes": "Asthma"})
    assert ok.status_code == 200
    assert ok.get_json()["user"]["bloodGroup"] == "O-"

    # Non-whitelisted columns must be ignored rather than mass-assigned.
    ignored = authed.patch("/api/auth/profile", {"id": "usr_hacker", "password_hash": "x", "createdAt": "1999-01-01T00:00:00Z"})
    assert ignored.status_code == 200
    assert ignored.get_json()["user"]["id"] == authed.user["id"]


def test_profile_email_conflict_rejected(authed, app):
    # A second, independent client so we do not clobber the first session cookie.
    from backend.tests.conftest import ApiClient

    other = ApiClient(app.test_client(), app)
    other.signup(name="Taken", email="taken@example.test", phone="+919000007777")
    conflict = authed.patch("/api/auth/profile", {"email": "taken@example.test"})
    assert conflict.status_code == 409
    assert conflict.get_json()["error"]["code"] == "email_taken"


def test_logout_clears_session(authed):
    assert authed.post("/api/auth/logout").status_code == 200
    assert authed.get("/api/contacts").status_code == 401