"""Flask application factory.

Wiring, in order:

1. Config (env-aware, production refuses a generated secret key).
2. Database schema.
3. Logging + request correlation.
4. Security middleware: origin guard, CSRF, security headers, CORS.
5. Notification provider registry.
6. Blueprints.
7. SPA static serving with a strict CSP-compatible path policy.
8. Session resolution for every request.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from flask import Flask, g, request, send_from_directory
from werkzeug.exceptions import NotFound as WerkzeugNotFound

from . import db
from .config import Config, load_config, resolve_secret_key
from .errors import register_error_handlers
from .logging_utils import configure_logging, log_event
from .security import (
    apply_cors,
    apply_security_headers,
    ensure_csrf_cookie,
    guard_origin,
    limiter,
    verify_csrf,
)

# Static assets that may be served. Anything else under the frontend directory
# that is not listed is refused, which keeps the static handler from becoming a
# file-read gadget.
ALLOWED_STATIC_SUFFIXES = {".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".webmanifest", ".txt", ".map"}
NO_INDEX_PREFIXES = ("/api/", "/static/")


def create_app(config_name: str | None = None, overrides: dict[str, Any] | None = None) -> Flask:
    cfg = load_config(config_name)
    app = Flask(
        __name__,
        static_folder=None,  # we serve the SPA ourselves for strict control
        template_folder="templates",
    )
    app.config.from_object(cfg)
    # `from_object` copies the (possibly empty) class attribute, so resolve the key
    # explicitly rather than relying on setdefault.
    app.config["SECRET_KEY"] = str((overrides or {}).get("SECRET_KEY") or resolve_secret_key(cfg))
    if overrides:
        app.config.update(overrides)

    configure_logging(app.config["LOG_LEVEL"], app.config["LOG_JSON"])
    db.init_db(app.config["DATABASE_PATH"])

    if not app.config.get("SECRET_KEY"):  # pragma: no cover
        raise RuntimeError("SECRET_KEY could not be resolved.")

    _register_middleware(app)
    _register_blueprints(app)
    register_error_handlers(app)
    _register_spa(app)
    _bootstrap(app)

    log_event(
        "app.started",
        environment=app.config.get("ENV"),
        demo_mode=bool(app.config.get("DEMO_MODE")),
        port=app.config.get("PORT"),
    )
    return app


# ------------------------------------------------------------- middleware


def _register_middleware(app: Flask) -> None:
    @app.before_request
    def _begin():
        g.request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
        g.user = None
        g.session_token = None
        _load_session(app)

    @app.before_request
    def _security_gate():
        guard_origin()
        verify_csrf()

    @app.after_request
    def _finish(response):
        ensure_csrf_cookie(response)
        response.headers.setdefault("X-Request-ID", getattr(g, "request_id", "-"))
        apply_security_headers(response)
        apply_cors(response)
        return response


def _load_session(app: Flask) -> None:
    """Resolve the signed session cookie to a user row.

    The cookie holds an opaque, signed session id. The user row is re-read on
    every request, so deleting or disabling an account revokes access
    immediately rather than waiting for the cookie to expire.
    """
    from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

    from . import repo

    raw = request.cookies.get(app.config["SESSION_COOKIE_NAME"])
    if not raw:
        return
    serializer = URLSafeTimedSerializer(app.config["SECRET_KEY"], salt="shesafe.session")
    try:
        token = serializer.loads(raw, max_age=int(app.config["PERMANENT_SESSION_LIFETIME"]))
    except (BadSignature, SignatureExpired):
        return
    if not isinstance(token, str) or len(token) > 64:
        return
    g.session_token = token
    user = repo.get_user(app.config["DATABASE_PATH"], token)
    if user is not None:
        g.user = user


def _register_blueprints(app: Flask) -> None:
    from .api import auth, contacts, demo, intelligence, journeys, location, meta, privacy, reports, sos

    app.register_blueprint(meta.bp)
    app.register_blueprint(auth.bp)
    app.register_blueprint(sos.bp)
    app.register_blueprint(contacts.bp)
    app.register_blueprint(location.bp)
    app.register_blueprint(intelligence.bp)
    app.register_blueprint(journeys.bp)
    app.register_blueprint(reports.bp)
    app.register_blueprint(privacy.bp)
    app.register_blueprint(demo.bp)


# ------------------------------------------------------------ static / SPA


def _register_spa(app: Flask) -> None:
    frontend_dir = Path(app.config["FRONTEND_DIR"]).resolve()

    def _safe_file(relative: str) -> Path | None:
        candidate = (frontend_dir / relative).resolve()
        try:
            candidate.relative_to(frontend_dir)
        except ValueError:
            return None  # traversal attempt
        if not candidate.is_file():
            return None
        if candidate.suffix.lower() not in ALLOWED_STATIC_SUFFIXES:
            return None
        return candidate

    @app.get("/")
    def index():
        return send_from_directory(frontend_dir, "index.html")

    @app.get("/<path:path>")
    def static_or_spa(path: str):
        if any(path.startswith(prefix.strip("/")) for prefix in NO_INDEX_PREFIXES):
            raise WerkzeugNotFound()
        target = _safe_file(path)
        if target is not None:
            return send_from_directory(frontend_dir, path)
        # Unknown non-API path: serve the shell so the hash router can take over,
        # but never for a path that looks like an asset.
        if "." in Path(path).name:
            raise WerkzeugNotFound()
        return send_from_directory(frontend_dir, "index.html")


# --------------------------------------------------------------- bootstrap


def _bootstrap(app: Flask) -> None:
    from .notifications import build_registry

    app.extensions["shesafe_notifications"] = build_registry(app.config)

    if app.config.get("SEED_ON_START"):
        from .seed import ensure_seed

        ensure_seed(app.config["DATABASE_PATH"], app.config)

    _start_cleanup_job(app)

    @app.teardown_appcontext
    def _close_db(_exc):
        # Flask reuses one thread-local connection; we keep it open for speed and
        # only drop it on interpreter shutdown.
        return None


def _start_cleanup_job(app: Flask) -> None:
    """Run the retention job on a timer.

    Location samples, expired share tokens and the audit log all need to age out
    on their own; a retention policy that only runs when a human remembers to
    press a button is not a retention policy. The job is a daemon thread, it is
    started only when the app is actually serving, and it never touches incident
    trails or incident records.
    """
    import threading

    from . import repo

    interval = int(app.config.get("CLEANUP_INTERVAL_SECONDS") or 0)
    if interval <= 0 or app.config.get("TESTING"):
        return

    stop = threading.Event()

    def loop() -> None:  # pragma: no cover - timing-dependent
        while not stop.wait(interval):
            try:
                dbp = app.config["DATABASE_PATH"]
                repo.purge_expired_share_tokens(dbp)
                repo.purge_old_locations(dbp, int(app.config["INCIDENT_LOCATION_RETENTION_DAYS"]))
                repo.trim_audit_log(dbp, int(app.config["AUDIT_RETENTION_DAYS"]))
                repo.purge_stale_emergency_state(dbp, int(app.config["STALE_INCIDENT_MAX_HOURS"]))
            except Exception:  # a cleanup failure must never take the app down
                app.logger.warning("retention cleanup failed", exc_info=False)

    thread = threading.Thread(target=loop, name="shesafe-retention", daemon=True)
    thread.start()
    app.extensions["shesafe_cleanup"] = {"stop": stop, "thread": thread}
    log_event("retention.job_started", interval_seconds=interval)