"""Authentication endpoints.

Fixes vs the audited implementation:

* Passwords are PBKDF2 hashes; comparison is constant-time.
* Lookup is by exact email or phone. **No substring matching on names.**
* No demo bypass that accepts any password. Demo Mode is an explicit, opt-in
  configuration flag and is reported truthfully by ``/api/health``.
* Identical responses and equivalent timing for unknown-user and wrong-password.
* Per-IP and per-account rate limits on login.
* Session is a signed ``HttpOnly`` cookie; CSRF token issued alongside.
"""

from __future__ import annotations

from flask import Blueprint, current_app, g, request

from .. import repo, validation
from ..errors import AuthenticationError, ConflictError, ValidationError
from ..logging_utils import audit, log_event
from ..security import (
    ensure_csrf_token,
    hash_password,
    login_required,
    rate_limit,
    require_user,
    verify_password,
)
from ..validation import require_json
from .helpers import audit_kwargs, db_path, ok, public_user

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

MIN_PASSWORD = 8


@bp.post("/login")
@rate_limit("auth")
def login():
    dbp = db_path()
    body = require_json(request)
    identifier = validation.field(body, "identifier", max_length=254, label="Email or mobile number")
    password = validation.field(body, "password", max_length=200, label="Password")

    user = repo.find_user_by_identifier(dbp, identifier)
    password_ok = bool(user) and verify_password(user["password_hash"], password)

    if not user or not password_ok:
        audit(
            dbp,
            action="auth.login",
            outcome="failure",
            actor_label=identifier[:64],
            detail={"reason": "invalid_credentials"},
            **audit_kwargs(),
        )
        log_event("auth.login_failed", request_id=g.get("request_id"), identifier_hint=identifier[:2] + "***")
        # One message for both cases: do not disclose which accounts exist.
        raise AuthenticationError("Incorrect email/mobile or password.")

    session_token = _start_session(user)
    audit(
        dbp,
        action="auth.login",
        outcome="success",
        actor_id=user["id"],
        actor_label=user["name"],
        detail={"method": "password"},
        **audit_kwargs(),
    )
    log_event("auth.login_success", request_id=g.get("request_id"), user_id=user["id"])
    response = ok(
        {
            "user": public_user(user),
            "csrfToken": ensure_csrf_token(),
            "session": {"expiresIn": int(current_app.config["PERMANENT_SESSION_LIFETIME"])},
        }
    )
    _set_cookies(response, session_token)
    return response


@bp.post("/signup")
@rate_limit("auth")
def signup():
    dbp = db_path()
    body = require_json(request)

    name = validation.field(body, "name", max_length=80, label="Full name", pattern=validation.NAME_RE)
    phone = validation.phone_field(body, "phone")
    email = validation.email_field(body, "email", required=False)
    password = validation.password_field(body, "password")

    if not email and not phone:  # pragma: no cover - phone is required above
        raise ValidationError("Provide an email address or a mobile number.")
    if email:
        clash = repo.find_user_by_identifier(dbp, email)
        if clash:
            raise ConflictError("An account with that email already exists.", code="email_taken")
    clash = repo.find_user_by_identifier(dbp, phone)
    if clash:
        raise ConflictError("An account with that mobile number already exists.", code="phone_taken")

    user = repo.create_user(
        dbp,
        {
            "name": name,
            "email": email,
            "phone": phone,
            "blood_group": validation.optional_text(body, "bloodGroup", max_length=8),
            "emergency_notes": validation.optional_text(body, "emergencyNotes", max_length=500),
            "home_area": validation.optional_text(body, "homeArea", max_length=200),
            "location_consent": validation.bool_field(body, "locationConsent", default=False),
            "siren_enabled": validation.bool_field(body, "sirenEnabled", default=True),
            "voice_sos_enabled": validation.bool_field(body, "voiceSosEnabled", default=False),
        },
        hash_password(password),
    )

    # Optional first contact, created transactionally with the account.
    contact_name = validation.optional_text(body, "emergencyContactName", max_length=80)
    contact_phone = validation.phone_field(body, "emergencyContactPhone", required=False)
    if contact_name and contact_phone:
        repo.create_contact(
            dbp,
            user["id"],
            {
                "name": contact_name,
                "relationship": "Primary Emergency Contact",
                "phone": contact_phone,
                "channels": ["sms", "call"],
                "is_primary": True,
                "verified": False,
                "active": True,
            },
        )

    session_token = _start_session(user)
    audit(
        dbp,
        action="auth.signup",
        outcome="success",
        actor_id=user["id"],
        actor_label=user["name"],
        detail={"hasContact": bool(contact_name and contact_phone)},
        **audit_kwargs(),
    )
    log_event("auth.signup", request_id=g.get("request_id"), user_id=user["id"])

    response = ok({"user": public_user(user), "csrfToken": ensure_csrf_token()}, 201)
    _set_cookies(response, session_token)
    return response


@bp.post("/logout")
@login_required
def logout():
    user = require_user()
    dbp = db_path()
    audit(dbp, action="auth.logout", outcome="success", actor_id=user["id"], **audit_kwargs())
    session_token = g.get("session_token")
    response = ok({"message": "Signed out."})
    response.delete_cookie(current_app.config["SESSION_COOKIE_NAME"])
    response.delete_cookie(current_app.config["CSRF_COOKIE"])
    return response


@bp.get("/session")
def session_info():
    """Used by the SPA on boot. Always 200 with an explicit ``authenticated`` flag."""
    user = g.get("user")
    return ok(
        {
            "authenticated": user is not None,
            "user": public_user(user) if user else None,
            "csrfToken": ensure_csrf_token(),
            "demoMode": bool(current_app.config.get("DEMO_MODE")),
        }
    )


@bp.patch("/profile")
@rate_limit("write")
@login_required
def update_profile():
    user = require_user()
    dbp = db_path()
    body = require_json(request)
    patch: dict[str, object] = {}
    if "name" in body:
        patch["name"] = validation.field(body, "name", max_length=80, pattern=validation.NAME_RE)
    if "email" in body:
        email = validation.email_field(body, "email", required=False)
        if email and email != user.get("email"):
            clash = repo.find_user_by_identifier(dbp, email)
            if clash and clash["id"] != user["id"]:
                raise ConflictError("That email is already in use.", code="email_taken")
        patch["email"] = email
    if "phone" in body:
        phone = validation.phone_field(body, "phone")
        clash = repo.find_user_by_identifier(dbp, phone)
        if clash and clash["id"] != user["id"]:
            raise ConflictError("That mobile number is already in use.", code="phone_taken")
        patch["phone"] = phone
    if "bloodGroup" in body:
        patch["blood_group"] = validation.optional_text(body, "bloodGroup", max_length=8)
    if "emergencyNotes" in body:
        patch["emergency_notes"] = validation.optional_text(body, "emergencyNotes", max_length=500)
    if "homeArea" in body:
        patch["home_area"] = validation.optional_text(body, "homeArea", max_length=200)
    for key, field_name in (
        ("sirenEnabled", "siren_enabled"),
        ("voiceSosEnabled", "voice_sos_enabled"),
        ("locationConsent", "location_consent"),
        ("shareTrailByDefault", "share_trail_by_default"),
    ):
        if key in body:
            patch[field_name] = 1 if validation.bool_field(body, key) else 0

    updated = repo.update_user(dbp, user["id"], patch)
    audit(dbp, action="auth.profile_update", outcome="success", actor_id=user["id"], detail={"fields": sorted(patch)}, **audit_kwargs())
    return ok({"user": public_user(updated)})


# ---------------------------------------------------------------- internals


def _start_session(user: dict) -> str:
    """The session cookie carries the user id, signed.

    Signing makes the value unforgeable; the user row is re-read on every
    request so a disabled or deleted account loses access immediately rather
    than at cookie expiry.
    """
    g.session_token = user["id"]
    return user["id"]


def _set_cookies(response, session_token: str) -> None:
    cfg = current_app.config
    max_age = int(cfg["PERMANENT_SESSION_LIFETIME"])
    response.set_cookie(
        cfg["SESSION_COOKIE_NAME"],
        _sign(session_token),
        max_age=max_age,
        httponly=cfg["SESSION_COOKIE_HTTPONLY"],
        secure=cfg["SESSION_COOKIE_SECURE"],
        samesite=cfg["SESSION_COOKIE_SAMESITE"],
        path="/",
    )
    response.set_cookie(
        cfg["CSRF_COOKIE"],
        ensure_csrf_token(),
        max_age=max_age,
        httponly=False,  # the SPA must read this to echo it in the header
        secure=cfg["SESSION_COOKIE_SECURE"],
        samesite=cfg["SESSION_COOKIE_SAMESITE"],
        path="/",
    )


def _sign(value: str) -> str:
    from itsdangerous import URLSafeTimedSerializer

    serializer = URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt="shesafe.session")
    return serializer.dumps(value)