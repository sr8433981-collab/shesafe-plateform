"""Location: telemetry ingest, live sharing, share tokens, guardian view.

Privacy posture
---------------
* Location is only accepted from an authenticated owner. There is no
  ``POST /api/location/update`` that trusts a body-supplied ``userId``.
* **Default is OFF.** Sharing is started explicitly; turning it off stops
  ingestion of shared samples immediately.
* Non-incident samples are kept for a short window (``SHESAFE_LOCATION_RETENTION_DAYS``,
  default 30) so a guardian can show recent context; they are purged on a timer.
* Share links carry a 256-bit random token. Only its SHA-256 is stored, so a
  database leak cannot be replayed. Tokens expire and can be revoked.
* The guardian endpoint accepts **only** a token. A user id in the URL does
  nothing.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from flask import Blueprint, current_app, g, request

from .. import db as dbmod
from .. import geo, repo, validation
from ..errors import AuthorizationError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError
from ..logging_utils import audit, iso, log_event, new_id
from ..security import hash_token, login_required, rate_limit, require_user
from ..validation import require_json
from .helpers import age_seconds, db_path, is_stale, ok, public_location

bp = Blueprint("location", __name__, url_prefix="/api")

MAX_ACCURACY = None  # resolved from config at call time


def _max_accuracy() -> float:
    return float(current_app.config["LOCATION_MAX_ACCURACY_METERS"])


def _stale_after() -> int:
    return int(current_app.config["LOCATION_STALE_AFTER_SECONDS"])


# ------------------------------------------------------------------ ingest


@bp.post("/location/ping")
@rate_limit("location")
@login_required
def ping():
    """Single authenticated telemetry sample.

    Rejects obviously unusable fixes (>``LOCATION_MAX_ACCURACY_METERS``) rather
    than storing a position that would mislead a responder.
    """
    user = require_user()
    dbp = db_path()
    body = require_json(request)
    lat = validation.lat_field(body, "lat")
    lng = validation.lng_field(body, "lng")
    accuracy = validation.accuracy_field(body, "accuracy")
    if accuracy is not None and accuracy > _max_accuracy():
        raise ValidationError(
            f"GPS fix is too imprecise (±{int(accuracy)}m). SheSafe will not record it as your location.",
            accuracy="too_imprecise",
        )

    incident = repo.find_active_incident(dbp, user["id"])
    incident_id = incident["id"] if incident else None
    sharing = bool(incident) or _sharing_enabled(dbp, user["id"])

    sample = repo.record_location_sample(
        dbp,
        user["id"],
        lat=lat,
        lng=lng,
        accuracy=accuracy,
        speed=_num(body.get("speed"), 0, 120),
        heading=_num(body.get("heading"), 0, 360),
        battery=validation.int_field(body, "battery", required=False, minimum=0, maximum=100),
        incident_id=incident_id if sharing else None,
        source="gps" if validation.bool_field(body, "isSimulated", default=False) is False else "simulated",
    )

    if incident_id and repo.incident_anchor(dbp, incident_id) is None:
        repo.record_incident_location(dbp, incident_id, lat, lng, accuracy, sample["source"])

    return ok(
        {
            "accepted": True,
            "recordedAt": sample["created_at"],
            "linkedToIncident": bool(incident_id),
            "retention": "incident samples are kept for the incident record; non-incident samples expire automatically.",
        }
    )


@bp.get("/location/latest")
@rate_limit("read")
@login_required
def latest():
    """The user's own last known position (used by the app's status header)."""
    user = require_user()
    dbp = db_path()
    sample = repo.latest_location(dbp, user["id"])
    return ok(
        {
            "location": public_location(sample),
            "ageSeconds": age_seconds(sample["created_at"]) if sample else None,
            "stale": is_stale(sample["created_at"], _stale_after()) if sample else True,
            "sharingActive": _sharing_enabled(dbp, user["id"]),
            "staleAfterSeconds": _stale_after(),
        }
    )


# ----------------------------------------------------------------- sharing


@bp.post("/location/share/start")
@rate_limit("location")
@login_required
def share_start():
    """Start live sharing and mint a share link."""
    user = require_user()
    dbp = db_path()
    body = request.get_json(silent=True) or {}
    ttl = validation.clamp_ttl(
        validation.int_field(body, "ttlSeconds", required=False, default=int(current_app.config["SHARE_TOKEN_DEFAULT_TTL"]), minimum=60, maximum=current_app.config["SHARE_TOKEN_MAX_TTL"]),
        maximum=int(current_app.config["SHARE_TOKEN_MAX_TTL"]),
    )
    include_trail = validation.bool_field(body, "includeTrail", default=bool(user.get("share_trail_by_default", 1)))
    label = validation.optional_text(body, "label", max_length=80) or "Live location"

    incident = repo.find_active_incident(dbp, user["id"])
    raw_token = _mint(dbp, user, incident["id"] if incident else None, label, ttl, include_trail)
    repo.update_user(dbp, user["id"], {"location_consent": 1})

    audit(
        dbp,
        action="location.share_start",
        outcome="success",
        actor_id=user["id"],
        target_type="incident" if incident else "user",
        target_id=(incident or {}).get("id"),
        detail={"ttlSeconds": ttl, "includeTrail": include_trail, "linkedToIncident": bool(incident)},
        **audit_kwargs(),
    )
    log_event("location.share_started", request_id=g.get("request_id"), user_id=user["id"], ttl=ttl)
    return ok(
        {
            "sharing": True,
            "shareUrl": _share_url(raw_token),
            "expiresAt": validation.future_iso(ttl),
            "ttlSeconds": ttl,
            "includeTrail": include_trail,
            "linkedToIncident": bool(incident),
            "warning": "Anyone with this link can view your position until it expires or you revoke it.",
        },
        201,
    )


@bp.get("/location/share/active")
@rate_limit("read")
@login_required
def share_active():
    user = require_user()
    dbp = db_path()
    tokens = repo.list_share_tokens(dbp, user["id"])
    now = datetime.now(timezone.utc)
    active = []
    for token in tokens:
        expires = _parse(token["expires_at"])
        revoked = bool(token["revoked_at"])
        expired = bool(expires and expires < now)
        active.append(
            {
                "id": token["id"],
                "label": token["label"],
                "scope": token["scope"],
                "includeTrail": bool(token["include_trail"]),
                "expiresAt": token["expires_at"],
                "revokedAt": token["revoked_at"],
                "status": "revoked" if revoked else ("expired" if expired else "active"),
                "viewCount": token["view_count"],
                "lastViewedAt": token["last_viewed_at"],
                "linkedIncidentId": token["incident_id"],
            }
        )
    return ok({"shares": active, "activeCount": sum(1 for s in active if s["status"] == "active")})


@bp.post("/location/share/revoke")
@rate_limit("location")
@login_required
def share_revoke():
    """Revoke one share link, or every link when no id is given."""
    user = require_user()
    dbp = db_path()
    body = request.get_json(silent=True) or {}
    share_id = body.get("shareId")
    if share_id:
        revoked = repo.revoke_share_token(dbp, user["id"], share_id)
        if not revoked:
            raise NotFoundError("Share link not found or already revoked.")
    else:
        for token in repo.list_share_tokens(dbp, user["id"]):
            repo.revoke_share_token(dbp, user["id"], token["id"])
        if not repo.find_active_incident(dbp, user["id"]):
            repo.update_user(dbp, user["id"], {"location_consent": 0})

    audit(
        dbp,
        action="location.share_revoke",
        outcome="success",
        actor_id=user["id"],
        target_type="share",
        target_id=share_id,
        detail={"scope": "single" if share_id else "all"},
        **audit_kwargs(),
    )
    return ok({"revoked": True, "scope": "single" if share_id else "all"})


# ------------------------------------------------------ guardian (token)


@bp.get("/track/<token>")
@rate_limit("read")
def track(token: str):
    """Guardian view. The token is the only credential."""
    dbp = db_path()
    if not token or len(token) < 32:
        raise AuthorizationError("This tracking link is not valid.")

    record = repo.get_share_token_by_hash(dbp, hash_token(token))
    if record is None:
        audit(dbp, action="location.track_view", outcome="denied", detail={"reason": "unknown_token"}, **audit_kwargs())
        raise AuthorizationError("This tracking link is not valid.")

    if record["revoked_at"]:
        audit(dbp, action="location.track_view", outcome="denied", actor_id=record["user_id"], target_type="share", target_id=record["id"], detail={"reason": "revoked"}, **audit_kwargs())
        raise AuthorizationError("This tracking link has been revoked by the user.")

    expires = _parse(record["expires_at"])
    if expires and expires < datetime.now(timezone.utc):
        audit(dbp, action="location.track_view", outcome="denied", actor_id=record["user_id"], target_type="share", target_id=record["id"], detail={"reason": "expired"}, **audit_kwargs())
        raise AuthorizationError("This tracking link has expired. Ask for a fresh link.")

    user = repo.get_user(dbp, record["user_id"])
    incident = repo.get_incident(dbp, record["user_id"], record["incident_id"]) if record["incident_id"] else None
    sample = repo.latest_location(dbp, record["user_id"])
    repo.touch_share_token(dbp, record["id"])

    trail = []
    if record["include_trail"] and record["incident_id"]:
        trail = [
            {"lat": row["lat"], "lng": row["lng"], "at": row["created_at"]}
            for row in repo.incident_trail(dbp, record["incident_id"], limit=300)
        ]

    stale = is_stale(sample["created_at"], _stale_after()) if sample else True
    return ok(
        {
            "subject": {
                "displayName": _mask_name(user["name"]) if user else "A SheSafe user",
                # Contact phone is masked: a share link should not leak the full number.
                "phone": _mask_phone(user.get("phone")) if user and user.get("phone") else None,
            },
            "location": public_location(sample),
            "locationAgeSeconds": age_seconds(sample["created_at"]) if sample else None,
            "locationStale": stale,
            "sharing": not stale,
            "trail": trail,
            "trailIncluded": bool(record["include_trail"]),
            "incident": None
            if incident is None
            else {
                "reference": incident["reference"],
                "state": incident["state"],
                "outcome": incident.get("outcome"),
                "startedAt": incident.get("started_at") or incident.get("created_at"),
                "resolvedAt": incident.get("resolved_at"),
            },
            "share": {
                "label": record["label"],
                "scope": record["scope"],
                "expiresAt": record["expires_at"],
            },
            "disclaimer": (
                "This is the last position received by SheSafe. If 'Sharing' is false the user "
                "is not currently sending location - the position may be old. Call 112 for emergencies."
            ),
        }
    )


# --------------------------------------------------------------- internals


def _num(value, lo: float, hi: float):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if lo <= result <= hi else None


def _parse(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _sharing_enabled(dbp, user_id: str) -> bool:
    """Sharing is active if an incident is open or a non-revoked token exists."""
    if repo.find_active_incident(dbp, user_id):
        return True
    now = datetime.now(timezone.utc)
    for token in repo.list_share_tokens(dbp, user_id):
        if token["revoked_at"]:
            continue
        expires = _parse(token["expires_at"])
        if expires is None or expires > now:
            return True
    return False


def _mint(dbp, user, incident_id, label: str, ttl: int, include_trail: bool) -> str:
    from ..security import new_token

    raw = f"shr_{new_token(32)}"
    repo.create_share_token(
        dbp,
        user_id=user["id"],
        token_hash=hash_token(raw),
        incident_id=incident_id,
        label=label,
        scope="incident" if incident_id else "live",
        include_trail=include_trail,
        expires_at=validation.future_iso(ttl),
    )
    return raw


def _share_url(raw: str) -> str:
    return f"{request.host_url.rstrip('/')}/track.html?t={raw}"


def _mask_name(name: str) -> str:
    parts = (name or "").split()
    if not parts:
        return "A SheSafe user"
    return f"{parts[0]} {'*' * max(2, len(parts[-1]) - 1)}"


def _mask_phone(value: str) -> str:
    digits = "".join(ch for ch in value if ch.isdigit())
    return f"***{digits[-4:]}" if len(digits) >= 4 else None


def audit_kwargs() -> dict:
    from .helpers import audit_kwargs as _kwargs

    return _kwargs()


def purge_expired_data():
    """Housekeeping: remove expired telemetry and revoked share links."""
    dbp = db_path()
    removed = repo.purge_old_locations(dbp, int(current_app.config["INCIDENT_LOCATION_RETENTION_DAYS"]))
    dbmod.execute(dbp, "DELETE FROM share_tokens WHERE expires_at < ?", (validation.future_iso(0),))
    return removed