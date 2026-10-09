"""Shared pytest fixtures.

Every test runs against a real SQLite database (a temp file, not a mock) so the
repository layer, constraints and migrations are genuinely exercised.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

os.environ.setdefault("SHESAFE_ENV", "testing")

from backend.app import create_app  # noqa: E402
from backend.app.security import limiter  # noqa: E402


@pytest.fixture()
def app(tmp_path):
    application = create_app(
        "testing",
        {
            "DATABASE_PATH": tmp_path / "test.db",
            "SEED_ON_START": False,
            "RATE_LIMIT_ENABLED": False,
            "DEMO_MODE": True,
            "PLACES_PROVIDER": "none",
            "ROUTING_PROVIDER": "none",
            "SECRET_KEY": "test-secret-key",
            "AI_PROVIDER": "none",
            "SMS_PROVIDER": "none",
        },
    )
    yield application
    limiter.reset()


@pytest.fixture()
def client(app):
    return app.test_client()


class ApiClient:
    """Thin wrapper that handles the CSRF double-submit token for the test client."""

    def __init__(self, flask_client, app):
        self._c = flask_client
        self._app = app
        self.user = None
        self.credentials = None
        self._token = None
        self._prime()

    def _prime(self):
        self._token = self._c.get("/api/auth/session").get_json()["csrfToken"]

    def _headers(self, extra=None):
        headers = {"X-CSRF-Token": self._token}
        if extra:
            headers.update(extra)
        return headers

    def _absorb(self, response):
        body = response.get_json(silent=True) or {}
        if isinstance(body, dict) and body.get("csrfToken"):
            self._token = body["csrfToken"]
        return response

    def get(self, path, **kwargs):
        kwargs.setdefault("headers", {})
        return self._c.get(path, headers=self._headers(kwargs["headers"]), **{k: v for k, v in kwargs.items() if k != "headers"})

    def post(self, path, json=None, headers=None, **kwargs):
        return self._absorb(
            self._c.post(path, json=json, headers=self._headers(headers), **kwargs)
        )

    def patch(self, path, json=None, headers=None, **kwargs):
        return self._absorb(
            self._c.patch(path, json=json, headers=self._headers(headers), **kwargs)
        )

    def delete(self, path, json=None, headers=None, **kwargs):
        return self._absorb(
            self._c.delete(path, json=json, headers=self._headers(headers), **kwargs)
        )

    def signup(self, name="Asha Tester", email=None, phone="+919000001234", password="Str0ngPass123"):
        email = email or f"{name.split()[0].lower()}{abs(hash(email or name)) % 9999}@example.test"
        response = self.post(
            "/api/auth/signup",
            {"name": name, "email": email, "phone": phone, "password": password},
        )
        assert response.status_code == 201, response.get_json()
        self.user = response.get_json()["user"]
        self.credentials = {"identifier": email or phone, "password": password}
        return self.user

    def login(self, identifier, password):
        response = self.post("/api/auth/login", {"identifier": identifier, "password": password})
        if response.status_code == 200:
            self.user = response.get_json()["user"]
        return response

    def reauthenticate(self):
        """Re-establish the session from the stored password.

        Used after a server-side role change, so the next request resolves the
        user row again instead of reusing a session created before the change.
        """
        self._prime()  # the previous logout may have cleared the CSRF cookie
        response = self.login(self.credentials["identifier"], self.credentials["password"])
        self._prime()
        return response

    def arm_and_activate(self, lat=28.6328, lng=77.2197, accuracy=12.0):
        arm = self.post("/api/sos/arm", {}).get_json()
        incident_id = arm["incident"]["id"]
        activate = self.post("/api/sos/activate", {"lat": lat, "lng": lng, "accuracy": accuracy})
        assert activate.status_code == 201, activate.get_json()
        return arm["incident"], activate.get_json()


@pytest.fixture()
def api(client, app):
    return ApiClient(client, app)


@pytest.fixture()
def authed(api):
    api.signup()
    return api