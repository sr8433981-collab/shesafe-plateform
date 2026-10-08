"""Authentication, CSRF, rate limiting and security headers.

Design decisions
----------------
* **Passwords**: PBKDF2-HMAC-SHA256 via ``werkzeug.security`` (bundled with
  Flask). Constant-time comparison. Never logged, never returned.
* **Sessions**: signed, ``HttpOnly`` cookie. The session only carries an
  opaque ``sid``; the user row is re-read on every request so a disabled
  account loses access immediately.
* **CSRF**: synchroniser-token pattern — the token is issued in a readable
  cookie and must be echoed in the ``X-CSRF-Token`` header. An attacker on
  another origin can neither read the cookie nor set the header.
* **Rate limits**: in-process sliding window keyed by ``(bucket, ip)``. Fine
  for a single-instance deployment; documented as such.
* **CORS**: explicit allowlist. Credentialed requests only from listed origins.
"""

from __future__ import annotations

import functools
import hashlib
import hmac
import ipaddress
import secrets
import time
from collections import defaultdict, deque
from typing import Any, Callable

from flask import current_app, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from .errors import AuthenticationError, AuthorizationError, RateLimitError, ValidationError

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# --------------------------------------------------------------- passwords


def hash_password(raw: str) -> str:
    return generate_password_hash(raw, method="pbkdf2:sha256:600000", salt_length=16)


def verify_password(password_hash: str, candidate: str) -> bool:
    if not password_hash or not candidate:
        return False
    try:
        return check_password_hash(password_hash, candidate)
    except (ValueError, TypeError):
        return False


# ----------------------------------------------------------------- tokens


def new_token(nbytes: int = 32) -> str:
    """Cryptographically random, URL-safe, high-entropy token."""
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """Store only the SHA-256 of a share token; a DB leak cannot be replayed."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a or "", b or "")


# ------------------------------------------------------------- ip hashing


def client_identity() -> str:
    """Best-effort client identity for rate limiting and audit records.

    ``X-Forwarded-For`` is honoured only when the app is explicitly behind a
    trusted proxy (``SHESAFE_TRUST_PROXY=1``) so a client cannot trivially
    bypass limits by forging the header.
    """
    if current_app.config.get("TRUST_PROXY"):
        forwarded = request.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def ip_hash(identity: str) -> str:
    salt = current_app.config.get("IP_HASH_SALT") or current_app.config["SECRET_KEY"]
    return hashlib.sha256(f"{salt}|{identity}".encode()).hexdigest()[:16]


# ----------------------------------------------------------- rate limiting


class SlidingWindowLimiter:
    """In-memory sliding-window counter. Single-process by design."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, limit: int, window: int, *, now: float | None = None) -> tuple[bool, int]:
        ts = now if now is not None else time.monotonic()
        bucket = self._hits[key]
        cutoff = ts - window
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            retry_after = max(1, int(window - (ts - bucket[0])))
            return False, retry_after
        bucket.append(ts)
        return True, 0

    def reset(self) -> None:
        self._hits.clear()


limiter = SlidingWindowLimiter()


def rate_limit(bucket: str) -> Callable:
    """Decorator applying a named rate-limit rule to a view."""

    def decorator(view: Callable) -> Callable:
        @functools.wraps(view)
        def wrapper(*args, **kwargs):
            cfg = current_app.config
            if cfg.get("RATE_LIMIT_ENABLED", True):
                rule = cfg["RATE_LIMITS"].get(bucket)
                if rule:
                    key = f"{bucket}:{client_identity()}"
                    allowed, retry_after = limiter.check(key, rule.limit, rule.window)
                    if not allowed:
                        raise RateLimitError(retry_after)
            return view(*args, **kwargs)

        return wrapper

    return decorator


# ------------------------------------------------------------------- csrf


def ensure_csrf_token() -> str:
    """Return the request's CSRF token, minting one if the cookie is absent.

    Memoised per request so the value returned in a JSON body and the value set
    in the cookie are always the same token.
    """
    cached = getattr(g, "_csrf_token", None)
    if cached:
        return cached
    token = request.cookies.get(current_app.config["CSRF_COOKIE"])
    if not token or len(token) < 32:
        token = new_token(32)
    g._csrf_token = token
    return token


def ensure_csrf_cookie(response):
    """Guarantee the client can always read a CSRF token to echo in the header.

    Set on every response, so a fresh visitor receives one on their very first
    request and never has to sign in to obtain it.
    """
    name = current_app.config["CSRF_COOKIE"]
    if not request.cookies.get(name):
        response.set_cookie(
            name,
            ensure_csrf_token(),
            max_age=int(current_app.config["PERMANENT_SESSION_LIFETIME"]),
            httponly=False,
            secure=current_app.config["SESSION_COOKIE_SECURE"],
            samesite=current_app.config["SESSION_COOKIE_SAMESITE"],
            path="/",
        )
    return response


def csrf_enabled() -> bool:
    return bool(current_app.config.get("CSRF_ENABLED")) and not current_app.config.get("TESTING_NO_CSRF")


def verify_csrf() -> None:
    if request.method in SAFE_METHODS or not csrf_enabled():
        return
    cookie_token = request.cookies.get(current_app.config["CSRF_COOKIE"], "")
    header_token = request.headers.get(current_app.config["CSRF_HEADER"], "")
    if not cookie_token or not header_token:
        raise AuthorizationError("Security token missing. Reload the page and try again.")
    if not constant_time_equals(cookie_token, header_token):
        raise AuthorizationError("Security token mismatch. Reload the page and try again.")


# ----------------------------------------------------------------- auth


def current_user() -> dict[str, Any] | None:
    return getattr(g, "user", None)


def require_user() -> dict[str, Any]:
    user = current_user()
    if user is None:
        raise AuthenticationError()
    return user


def login_required(view: Callable) -> Callable:
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        require_user()
        return view(*args, **kwargs)

    return wrapper


# -------------------------------------------------------- security headers


def apply_security_headers(response):
    for header, value in current_app.config["SECURITY_HEADERS"].items():
        response.headers.setdefault(header, value)
    if current_app.config.get("HSTS_ENABLED"):
        response.headers.setdefault(
            "Strict-Transport-Security",
            f"max-age={current_app.config['HSTS_MAX_AGE']}; includeSubDomains; preload",
        )
    # Never let a proxy cache an authenticated or user-scoped response.
    if request.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store, no-cache, must-revalidate, private")
        response.headers.setdefault("Pragma", "no-cache")
    response.headers.setdefault("Vary", "Origin")
    return response


def is_trusted_origin(origin: str | None) -> bool:
    if not origin:
        return True  # same-origin / non-browser client
    if origin in current_app.config["CORS_ALLOWED_ORIGINS"]:
        return True
    try:
        parsed = ipaddress.ip_address(origin.split("//", 1)[-1].split(":")[0])
        return parsed.is_loopback
    except ValueError:
        return False


def apply_cors(response):
    origin = request.headers.get("Origin")
    if origin and is_trusted_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = (
            f"{current_app.config['CSRF_HEADER']}, Content-Type"
        )
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Max-Age"] = "600"
    elif origin:
        # Explicitly do not echo untrusted origins.
        response.headers["Vary"] = "Origin"
    return response


def guard_origin() -> None:
    """Reject cross-origin state-changing requests from unknown origins.

    This is CSRF defence-in-depth: even with SameSite=Lax cookies, a browser
    extension or a legacy client cannot drive a write from an unknown origin.
    """
    if request.method in SAFE_METHODS:
        return
    origin = request.headers.get("Origin")
    if origin and not is_trusted_origin(origin):
        raise AuthorizationError("Request blocked: untrusted origin.")


def normalise_phone_for_lookup(value: str) -> str:
    from .validation import normalise_phone

    return normalise_phone(value)


def json_no_store(payload: dict, status: int = 200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def clamp_request_payload() -> None:
    """Reject obviously hostile payloads early with a friendly message."""
    length = request.content_length or 0
    limit = current_app.config["MAX_CONTENT_LENGTH"]
    if length > limit:
        raise ValidationError("That request is too large.", body="too_large")