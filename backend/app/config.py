"""Application configuration.

All tunables live here. Nothing secret is ever committed: in production the
secret key, notification credentials and AI provider keys must come from the
environment. In development we derive a stable, *insecure-by-design* key and
loudly warn about it.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BASE_DIR.parent
FRONTEND_DIR = REPO_DIR / "frontend"


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        return float(raw) if raw is not None else default
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class RateLimitRule:
    """Sliding-window limit: ``limit`` requests per ``window`` seconds."""

    limit: int
    window: int


class Config:
    """Base configuration (development-friendly defaults)."""

    ENV = os.environ.get("SHESAFE_ENV", "development")
    DEBUG = False
    TESTING = False

    SECRET_KEY = os.environ.get("SHESAFE_SECRET_KEY", "")
    HOST = os.environ.get("HOST", "127.0.0.1")
    PORT = _int_env("PORT", 5000)

    FRONTEND_DIR = FRONTEND_DIR
    DATABASE_PATH = Path(os.environ.get("SHESAFE_DB", BASE_DIR / "data" / "shesafe.db"))

    # --- Security -------------------------------------------------------
    SESSION_COOKIE_NAME = "shesafe_session"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = _bool_env("SHESAFE_SECURE_COOKIES", False)
    PERMANENT_SESSION_LIFETIME = _int_env("SHESAFE_SESSION_TTL", 60 * 60 * 8)
    CSRF_ENABLED = True
    CSRF_HEADER = "X-CSRF-Token"
    CSRF_COOKIE = "shesafe_csrf"
    MAX_CONTENT_LENGTH = _int_env("SHESAFE_MAX_BODY", 64 * 1024)

    CORS_ALLOWED_ORIGINS = tuple(
        o.strip()
        for o in os.environ.get("SHESAFE_CORS_ORIGINS", "http://localhost:5000,http://127.0.0.1:5000,http://localhost:3000,http://127.0.0.1:3000").split(",")
        if o.strip()
    )

    SECURITY_HEADERS = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "geolocation=(self), microphone=(self), camera=(), payment=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": (
            "default-src 'self'; "
            "script-src 'self' https://unpkg.com; "
            "style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com; "
            "connect-src 'self' https://nominatim.openstreetmap.org https://*.tile.openstreetmap.org https://unpkg.com; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
        ),
    }
    HSTS_ENABLED = _bool_env("SHESAFE_HSTS", False)
    HSTS_MAX_AGE = 31_536_000

    # --- Rate limiting (per client IP + bucket) -------------------------
    RATE_LIMITS = {
        "auth": RateLimitRule(limit=_int_env("SHESAFE_RL_AUTH", 12), window=300),
        "sos": RateLimitRule(limit=_int_env("SHESAFE_RL_SOS", 30), window=60),
        "location": RateLimitRule(limit=_int_env("SHESAFE_RL_LOCATION", 120), window=60),
        "write": RateLimitRule(limit=_int_env("SHESAFE_RL_WRITE", 60), window=60),
        "read": RateLimitRule(limit=_int_env("SHESAFE_RL_READ", 300), window=60),
        "external": RateLimitRule(limit=_int_env("SHESAFE_RL_EXTERNAL", 30), window=60),
    }
    RATE_LIMIT_ENABLED = True

    # --- Emergency / safety behaviour -----------------------------------
    SOS_CANCEL_GRACE_SECONDS = _int_env("SHESAFE_SOS_GRACE", 10)
    SOS_ESCALATE_AFTER_SECONDS = _int_env("SHESAFE_SOS_ESCALATE_AFTER", 300)
    LOCATION_STALE_AFTER_SECONDS = _int_env("SHESAFE_LOCATION_STALE", 90)
    LOCATION_MAX_ACCURACY_METERS = _float_env("SHESAFE_LOCATION_MAX_ACCURACY", 200.0)
    SHARE_TOKEN_DEFAULT_TTL = _int_env("SHESAFE_SHARE_TTL", 3600)
    SHARE_TOKEN_MAX_TTL = _int_env("SHESAFE_SHARE_TTL_MAX", 24 * 3600)
    INCIDENT_LOCATION_RETENTION_DAYS = _int_env("SHESAFE_LOCATION_RETENTION_DAYS", 30)
    AUDIT_RETENTION_DAYS = _int_env("SHESAFE_AUDIT_RETENTION_DAYS", 180)
    CLEANUP_INTERVAL_SECONDS = _int_env("SHESAFE_CLEANUP_INTERVAL", 900)
    STALE_INCIDENT_MAX_HOURS = _int_env("SHESAFE_STALE_INCIDENT_HOURS", 24)

    # --- Contact ownership verification -----------------------------------
    # Provider path: a one-time code is delivered to the contact and read back.
    # Without a provider the attempt is recorded as SIMULATED and says so.
    CONTACT_VERIFICATION_TTL_SECONDS = _int_env("SHESAFE_VERIFICATION_TTL", 600)
    CONTACT_VERIFICATION_MAX_ATTEMPTS = _int_env("SHESAFE_VERIFICATION_MAX_ATTEMPTS", 5)

    # --- Moderation -------------------------------------------------------
    # Moderation is a moderator-role action. Demo Mode opens it to any signed-in
    # account so the flow can be demonstrated, and the API says so in every
    # moderation response. Production forces it closed regardless of the
    # environment variable.
    # ``None`` means "follow DEMO_MODE". Set to 1 to open moderation outside
    # Demo Mode; production ignores this entirely.
    MODERATION_OPEN_TO_ALL_USERS = (
        True
        if os.environ.get("SHESAFE_OPEN_MODERATION", "").strip().lower() in {"1", "true", "yes", "on"}
        else None
    )

    # --- Demo mode ------------------------------------------------------
    DEMO_MODE = _bool_env("SHESAFE_DEMO_MODE", False)

    # --- External providers (all optional, all honestly reported) -------
    EXTERNAL_HTTP_TIMEOUT = _float_env("SHESAFE_HTTP_TIMEOUT", 8.0)
    ROUTING_PROVIDER = os.environ.get("SHESAFE_ROUTING_PROVIDER", "osrm")
    PLACES_PROVIDER = os.environ.get("SHESAFE_PLACES_PROVIDER", "overpass")
    OVERPASS_MIRRORS = tuple(
        m.strip()
        for m in os.environ.get(
            "SHESAFE_OVERPASS_MIRRORS",
            "https://overpass-api.de/api/interpreter,"
            "https://overpass.kumi.systems/api/interpreter,"
            "https://overpass.private.coffee/api/interpreter,"
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        ).split(",")
        if m.strip()
    )
    PLACES_CACHE_TTL = _int_env("SHESAFE_PLACES_CACHE_TTL", 900)

    # --- Notifications --------------------------------------------------
    # Providers stay "unavailable" (honestly reported) unless credentials exist.
    SMS_PROVIDER = os.environ.get("SHESAFE_SMS_PROVIDER", "none")  # none | twilio | msg91
    SMS_ACCOUNT_SID = os.environ.get("SHESAFE_SMS_ACCOUNT_SID", "")
    SMS_AUTH_TOKEN = os.environ.get("SHESAFE_SMS_AUTH_TOKEN", "")
    SMS_FROM = os.environ.get("SHESAFE_SMS_FROM", "")
    MSG91_AUTH_KEY = os.environ.get("SHESAFE_MSG91_AUTH_KEY", "")
    MSG91_SENDER_ID = os.environ.get("SHESAFE_MSG91_SENDER_ID", "")
    WHATSAPP_PROVIDER = os.environ.get("SHESAFE_WHATSAPP_PROVIDER", "none")  # none | twilio | meta
    PUSH_PROVIDER = os.environ.get("SHESAFE_PUSH_PROVIDER", "none")  # none | fcm
    FCM_SERVER_KEY = os.environ.get("SHESAFE_FCM_SERVER_KEY", "")

    # --- AI (advisory only; never gates SOS) ----------------------------
    AI_PROVIDER = os.environ.get("SHESAFE_AI_PROVIDER", "none")  # none | openai_compatible
    AI_ENDPOINT = os.environ.get("SHESAFE_AI_ENDPOINT", "")
    AI_MODEL = os.environ.get("SHESAFE_AI_MODEL", "")
    AI_API_KEY = os.environ.get("SHESAFE_AI_API_KEY", "")
    AI_TIMEOUT = _float_env("SHESAFE_AI_TIMEOUT", 10.0)

    # --- Observability ---------------------------------------------------
    LOG_LEVEL = os.environ.get("SHESAFE_LOG_LEVEL", "INFO").upper()
    LOG_JSON = _bool_env("SHESAFE_LOG_JSON", True)
    AUDIT_LOG_ENABLED = True

    # Seed/demo bootstrap: created on first run so `flask run` always works.
    SEED_ON_START = _bool_env("SHESAFE_SEED", True)
    SEED_DEMO_USER_PASSWORD = os.environ.get("SHESAFE_DEMO_PASSWORD", "shesafe-demo")

    extra: dict = field(default_factory=dict)


class ProductionConfig(Config):
    ENV = "production"
    SESSION_COOKIE_SECURE = True
    HSTS_ENABLED = True
    # Production never leaves moderation open to any signed-in account, whatever
    # the environment says.
    MODERATION_OPEN_TO_ALL_USERS = False
    # Production is never a demo. `DEMO_MODE` exposes /api/demo/reset and
    # /api/demo/script to any signed-in account, and `SEED_ON_START` (default
    # True) seeds demo@shesafe.local with the publicly documented password
    # `shesafe-demo` on every boot. Neither may be switched on by an env var in
    # production: a real deployment must not ship a working account whose
    # credentials are printed in the README.
    DEMO_MODE = False
    SEED_ON_START = False
    CORS_ALLOWED_ORIGINS = tuple(
        o.strip()
        for o in os.environ.get("SHESAFE_CORS_ORIGINS", "").split(",")
        if o.strip()
    )


class TestingConfig(Config):
    TESTING = True
    SECRET_KEY = "testing-only-not-secret"
    # A shared in-memory database by default, overridable so a browser-driven
    # test can point at a real file.
    DATABASE_PATH = Path(os.environ.get("SHESAFE_DB", ":memory:"))
    CSRF_ENABLED = True
    DEMO_MODE = _bool_env("SHESAFE_DEMO_MODE", False)
    SEED_ON_START = _bool_env("SHESAFE_SEED", False)
    RATE_LIMIT_ENABLED = False
    EXTERNAL_HTTP_TIMEOUT = 1.0
    SEED_DEMO_USER_PASSWORD = "shesafe-demo"


CONFIGS = {
    "development": Config,
    "production": ProductionConfig,
    "testing": TestingConfig,
}


def load_config(name: str | None = None) -> type[Config]:
    key = (name or os.environ.get("SHESAFE_ENV") or "development").lower()
    return CONFIGS.get(key, Config)


def resolve_secret_key(cfg: type[Config]) -> str:
    """Return a usable secret key, generating an ephemeral dev key if needed."""
    if cfg.SECRET_KEY:
        return cfg.SECRET_KEY
    if cfg.TESTING:
        return "testing-only-not-secret"
    if cfg.ENV == "production":
        raise RuntimeError(
            "SHESAFE_SECRET_KEY is required in production. Refusing to start with a generated key."
        )
    # Stable-per-machine dev key so a demo session survives a restart, derived
    # from local machine identity + install path. Nothing secret is committed,
    # and no key material is shared between developers.
    fingerprint = f"{os.uname().nodename}|{BASE_DIR}"
    return hashlib.sha256(f"shesafe-dev:{fingerprint}".encode()).hexdigest()