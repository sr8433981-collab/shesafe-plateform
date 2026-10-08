"""Structured JSON logging + durable audit trail.

Two distinct concerns:

* ``log_event`` -> stdout JSON logs. Operational, greppable, correlation-ID
  aware. Contains **no precise coordinates** and never a full phone number.
* ``audit``     -> the ``audit_log`` table. Security-relevant, persistent,
  append-only, queryable by an operator.

Privacy rule enforced here: precise location (lat/lng) and raw contact phone
numbers are reduced (rounded / masked) before they can reach a log sink.
"""

from __future__ import annotations

import json
import logging
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from . import db

# Events that must never be emitted with payload details.
_SENSITIVE_KEYS = {"password", "password_hash", "token", "raw_token", "csrf", "authorization"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or utcnow()).astimezone(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    """URL-safe, unguessable identifier (never a timestamp)."""
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def human_reference(prefix: str = "SS") -> str:
    """Short human-facing reference a person can read out over the phone."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no ambiguous chars
    raw = uuid.uuid4().int
    chars = []
    for _ in range(6):
        raw, rem = divmod(raw, len(alphabet))
        chars.append(alphabet[rem])
    return f"{prefix}-{''.join(chars)}"


def scrub(payload: Any) -> Any:
    """Recursively drop secrets and coarsen precise location."""
    if isinstance(payload, dict):
        out = {}
        for key, value in payload.items():
            lowered = str(key).lower()
            if lowered in _SENSITIVE_KEYS:
                out[key] = "[redacted]"
            elif lowered in {"lat", "lng", "latitude", "longitude"} and isinstance(value, (int, float)):
                # ~110 m grid: enough for forensics, useless for stalking.
                out[key] = round(float(value), 2)
            else:
                out[key] = scrub(value)
        return out
    if isinstance(payload, (list, tuple)):
        return [scrub(v) for v in payload]
    return payload


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": iso(datetime.fromtimestamp(record.created, tz=timezone.utc)),
            "level": record.levelname,
            "event": getattr(record, "event", record.name),
            "request_id": getattr(record, "request_id", None),
        }
        extra = getattr(record, "extra_fields", None)
        if extra:
            payload.update(scrub(extra))
        if record.levelno >= logging.ERROR and record.exc_info:
            payload["error"] = self.formatException(record.exc_info)[-1200:]
        return json.dumps(payload, separators=(",", ":"), default=str)


def configure_logging(level: str = "INFO", json_output: bool = True) -> None:
    root = logging.getLogger("shesafe")
    root.handlers.clear()
    handler = logging.StreamHandler(sys.stdout)
    if json_output:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s %(message)s")
        )
    root.addHandler(handler)
    root.setLevel(getattr(logging, level, logging.INFO))
    root.propagate = False
    logging.getLogger("werkzeug").setLevel(logging.WARNING)


_logger = logging.getLogger("shesafe.core")


def log_event(
    event: str,
    *,
    level: int = logging.INFO,
    request_id: str | None = None,
    **fields: Any,
) -> None:
    _logger.log(
        level,
        event,
        extra={"event": event, "request_id": request_id, "extra_fields": scrub(fields)},
    )


def audit(
    database_path,
    *,
    action: str,
    outcome: str,
    actor_id: str | None = None,
    actor_label: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    request_id: str | None = None,
    ip_hash: str | None = None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Append to the durable audit log. Never raises into the request path."""
    try:
        db.execute(
            database_path,
            """
            INSERT INTO audit_log
                (actor_id, actor_label, action, outcome, target_type, target_id,
                 request_id, ip_hash, detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                actor_id,
                actor_label,
                action,
                outcome,
                target_type,
                target_id,
                request_id,
                ip_hash,
                json.dumps(scrub(detail or {}), default=str),
                iso(),
            ),
        )
    except Exception as exc:  # pragma: no cover - auditing must never break a request
        log_event("audit.write_failed", level=logging.ERROR, error=str(exc), action=action)