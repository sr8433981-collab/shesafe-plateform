"""Repository layer.

All SQL lives here so the rest of the app never touches the database directly.
Every function that takes a ``user_id`` scopes to that user — this is the
single place where the IDOR class of bug is prevented.
"""

from __future__ import annotations

import json
from typing import Any

from . import db
from .logging_utils import iso, new_id, utcnow
from .validation import normalise_phone


# ------------------------------------------------------------------ users


def get_user(db_path, user_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
    """Fetch a user by id.

    A soft-deleted account is invisible here by default. That is what makes
    account deletion take effect immediately: the session cookie still carries
    the id, but the row is no longer resolvable, so the very next request is
    unauthenticated.
    """
    sql = "SELECT * FROM users WHERE id = ?"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    return db.row_to_dict(db.query_one(db_path, sql, (user_id,)))


def find_user_by_identifier(db_path, identifier: str) -> dict[str, Any] | None:
    ident = (identifier or "").strip().lower()
    if not ident:
        return None
    phone = normalise_phone(ident)
    phone_digits = "".join(character for character in phone if character.isdigit())
    phone_candidates = {ident, phone, phone_digits}
    if phone.startswith("+91") and len(phone_digits) == 12:
        phone_candidates.add(phone_digits[2:])
    stored_phone = (
        "replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), "
        "'(', ''), ')', ''), '.', '')"
    )
    row = db.query_one(
        db_path,
        f"""
        SELECT * FROM users
        WHERE lower(email) = ? OR lower(name) = ? OR {stored_phone} IN ({", ".join("?" for _ in phone_candidates)})
        LIMIT 1
        """,
        (ident, ident, *phone_candidates),
    )
    return db.row_to_dict(row)


def find_user_by_contact(db_path, identifier: str) -> dict[str, Any] | None:
    """Look up by email or phone for the guardian/tracker portal."""
    ident = (identifier or "").strip().lower()
    if not ident:
        return None
    phone = normalise_phone(ident)
    row = db.query_one(
        db_path,
        "SELECT u.* FROM users u JOIN contacts c ON c.user_id = u.id "
        "WHERE (lower(c.phone) = ? OR u.phone = ? OR u.phone = ?) LIMIT 1",
        (ident, phone, phone),
    )
    return db.row_to_dict(row)


def create_user(db_path, data: dict[str, Any], password_hash: str) -> dict[str, Any]:
    now = iso()
    user_id = new_id("usr")
    db.execute(
        db_path,
        """
        INSERT INTO users (id, name, email, phone, password_hash, blood_group,
                           emergency_notes, home_area, siren_enabled, voice_sos_enabled,
                           location_consent, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user_id,
            data["name"],
            data.get("email"),
            data.get("phone"),
            password_hash,
            data.get("blood_group"),
            data.get("emergency_notes"),
            data.get("home_area"),
            1 if data.get("siren_enabled", True) else 0,
            1 if data.get("voice_sos_enabled", False) else 0,
            1 if data.get("location_consent", False) else 0,
            now,
            now,
        ),
    )
    return get_user(db_path, user_id)  # type: ignore[return-value]


def update_user(db_path, user_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {
        "name", "email", "phone", "blood_group", "emergency_notes", "home_area",
        "siren_enabled", "voice_sos_enabled", "location_consent", "share_trail_by_default",
    }
    fields = {k: v for k, v in patch.items() if k in allowed}
    if not fields:
        return get_user(db_path, user_id)
    assignments = ", ".join(f"{k} = ?" for k in fields)
    db.execute(
        db_path,
        f"UPDATE users SET {assignments}, updated_at = ? WHERE id = ?",
        (*fields.values(), iso(), user_id),
    )
    return get_user(db_path, user_id)


def set_user_role(db_path, user_id: str, role: str) -> dict[str, Any] | None:
    """Role changes are operator-only and deliberately not part of ``update_user``.

    Keeping this a separate function means no request handler can promote an
    account by accident through a profile patch.
    """
    db.execute(db_path, "UPDATE users SET role = ?, updated_at = ? WHERE id = ?", (role, iso(), user_id))
    return get_user(db_path, user_id)


def soft_delete_user(db_path, user_id: str) -> bool:
    """Mark an account deleted.

    A soft delete is what makes account deletion immediate and irreversible from
    the session's point of view: ``_load_session`` refuses a deleted row on the
    very next request, so a stolen or retained cookie stops working without
    waiting for its expiry.
    """
    cur = db.execute(db_path, "UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?", (iso(), iso(), user_id))
    return bool(cur.rowcount)


def purge_user_personal_data(db_path, user_id: str) -> dict[str, int]:
    """Delete everything that identifies a person, after account deletion.

    Incident rows are **kept and anonymised** rather than deleted. Two reasons:
    a safety product must be able to show someone their own history, and
    silently removing the record of an emergency would itself be a data decision
    taken without the user. What is removed is everything that points at a
    person: coordinates, phone numbers, names, the session identity, and the
    audit entries that name them.
    """
    counts: dict[str, int] = {}
    for table, sql in (
        ("notification_attempts", "DELETE FROM notification_attempts WHERE user_id = ?"),
        ("incident_locations", "DELETE FROM incident_locations WHERE incident_id IN (SELECT id FROM incidents WHERE user_id = ?)"),
        ("location_samples", "DELETE FROM location_samples WHERE user_id = ?"),
        ("share_tokens", "DELETE FROM share_tokens WHERE user_id = ?"),
        ("journey_events", "DELETE FROM journey_events WHERE journey_id IN (SELECT id FROM journeys WHERE user_id = ?)"),
        ("journeys", "DELETE FROM journeys WHERE user_id = ?"),
        ("check_ins", "DELETE FROM check_ins WHERE user_id = ?"),
        ("report_votes", "DELETE FROM report_votes WHERE user_id = ?"),
        ("contacts", "DELETE FROM contacts WHERE user_id = ?"),
        ("community_reports", "UPDATE community_reports SET user_id = NULL, place_label = NULL WHERE user_id = ?"),
        ("audit_log", "UPDATE audit_log SET actor_id = NULL, actor_label = NULL WHERE actor_id = ?"),
    ):
        cur = db.execute(db_path, sql, (user_id,))
        counts[table] = cur.rowcount or 0

    # Anonymise rather than delete: the row keeps foreign-key integrity for the
    # incident records, and keeps the session id unresolvable.
    cur = db.execute(
        db_path,
        """
        UPDATE users
        SET name = 'Deleted account', email = NULL, phone = NULL,
            password_hash = ?, blood_group = NULL, emergency_notes = NULL,
            home_area = NULL, updated_at = ?
        WHERE id = ?
        """,
        (f"deleted-{new_id('usr')}", iso(), user_id),
    )
    counts["users"] = cur.rowcount or 0
    return counts


def user_row_counts(db_path, user_id: str) -> dict[str, int]:
    return {
        table: int((db.query_one(db_path, f"SELECT COUNT(*) AS c FROM {table} WHERE user_id = ?", (user_id,)) or {"c": 0})["c"])
        for table in ("incidents", "contacts", "journeys", "check_ins", "location_samples", "share_tokens", "community_reports")
    }


# --------------------------------------------------------------- contacts


def list_contacts(db_path, user_id: str, *, include_inactive: bool = True) -> list[dict[str, Any]]:
    sql = "SELECT * FROM contacts WHERE user_id = ?"
    if not include_inactive:
        sql += " AND active = 1"
    sql += " ORDER BY is_primary DESC, created_at ASC"
    rows = db.rows_to_dicts(db.query(db_path, sql, (user_id,)))
    for row in rows:
        row["channels"] = _decode_json(row.get("channels"), ["sms", "call"])
        row["is_primary"] = bool(row["is_primary"])
        row["verified"] = bool(row["verified"])
        row["active"] = bool(row["active"])
    return rows


def get_contact(db_path, user_id: str, contact_id: str) -> dict[str, Any] | None:
    row = db.query_one(
        db_path, "SELECT * FROM contacts WHERE id = ? AND user_id = ?", (contact_id, user_id)
    )
    if row is None:
        return None
    contact = db.row_to_dict(row)
    contact["channels"] = _decode_json(contact.get("channels"), ["sms", "call"])
    contact["is_primary"] = bool(contact["is_primary"])
    contact["verified"] = bool(contact["verified"])
    contact["active"] = bool(contact["active"])
    return contact


def create_contact(db_path, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
    now = iso()
    contact_id = new_id("cnt")
    if data.get("is_primary"):
        db.execute(db_path, "UPDATE contacts SET is_primary = 0 WHERE user_id = ?", (user_id,))
    db.execute(
        db_path,
        """
        INSERT INTO contacts (id, user_id, name, relationship, phone, channels,
                              is_primary, verified, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            contact_id,
            user_id,
            data["name"],
            data.get("relationship") or "Emergency Contact",
            data.get("phone"),
            json.dumps(data.get("channels") or ["sms", "call"]),
            1 if data.get("is_primary") else 0,
            1 if data.get("verified") else 0,
            1 if data.get("active", True) else 0,
            now,
            now,
        ),
    )
    return get_contact(db_path, user_id, contact_id)  # type: ignore[return-value]


def update_contact(db_path, user_id: str, contact_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    existing = get_contact(db_path, user_id, contact_id)
    if existing is None:
        return None
    # Explicit ``None`` means "clear this column" (used to destroy a verification
    # code). The API layer already drops ``None`` from client patches, so a value
    # can only become NULL here when the server itself asked for it.
    merged = {**existing, **patch}
    if not merged.get("name") or not merged.get("phone"):
        return existing
    if merged.get("is_primary"):
        db.execute(
            db_path,
            "UPDATE contacts SET is_primary = 0 WHERE user_id = ? AND id != ?",
            (user_id, contact_id),
        )
    db.execute(
        db_path,
        """
        UPDATE contacts SET name = ?, relationship = ?, phone = ?, channels = ?,
                           is_primary = ?, verified = ?, verified_by = ?, verified_at = ?,
                           verification_requested_at = ?, verification_code_hash = ?,
                           verification_expires_at = ?, verification_attempts = ?,
                           active = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
        """,
        (
            merged["name"],
            merged.get("relationship"),
            merged.get("phone"),
            json.dumps(merged.get("channels") or ["sms", "call"]),
            1 if merged.get("is_primary") else 0,
            1 if merged.get("verified") else 0,
            merged.get("verified_by"),
            merged.get("verified_at"),
            merged.get("verification_requested_at"),
            merged.get("verification_code_hash"),
            merged.get("verification_expires_at"),
            int(merged.get("verification_attempts") or 0),
            1 if merged.get("active", True) else 0,
            iso(),
            contact_id,
            user_id,
        ),
    )
    return get_contact(db_path, user_id, contact_id)


# --------------------------------------------------------- verification


def start_contact_verification(
    db_path,
    user_id: str,
    contact_id: str,
    *,
    code_hash: str,
    ttl_seconds: int,
    provider: str,
) -> dict[str, Any] | None:
    """Record that a one-time verification code was dispatched for a contact.

    Only the hash of the code is stored, exactly like a password: a database
    leak cannot be replayed to impersonate the contact.
    """
    now = utcnow()
    from datetime import timedelta

    db.execute(
        db_path,
        """
        UPDATE contacts
        SET verification_requested_at = ?, verification_code_hash = ?,
            verification_expires_at = ?, verification_attempts = 0, updated_at = ?
        WHERE id = ? AND user_id = ?
        """,
        (
            iso(now),
            code_hash,
            iso(now + timedelta(seconds=ttl_seconds)),
            iso(),
            contact_id,
            user_id,
        ),
    )
    return get_contact(db_path, user_id, contact_id)


def confirm_contact_verification(db_path, user_id: str, contact_id: str) -> dict[str, Any] | None:
    """Mark a contact as provider-verified and destroy the code."""
    db.execute(
        db_path,
        """
        UPDATE contacts
        SET verified = 1, verified_by = 'provider', verified_at = ?,
            verification_code_hash = NULL, verification_expires_at = NULL,
            verification_requested_at = NULL, updated_at = ?
        WHERE id = ? AND user_id = ?
        """,
        (iso(), iso(), contact_id, user_id),
    )
    return get_contact(db_path, user_id, contact_id)


def record_verification_attempt(db_path, user_id: str, contact_id: str) -> int:
    db.execute(
        db_path,
        "UPDATE contacts SET verification_attempts = verification_attempts + 1 WHERE id = ? AND user_id = ?",
        (contact_id, user_id),
    )
    row = db.query_one(db_path, "SELECT verification_attempts FROM contacts WHERE id = ? AND user_id = ?", (contact_id, user_id))
    return int(row["verification_attempts"]) if row else 0


def clear_contact_verification(db_path, user_id: str, contact_id: str, *, revoke_verified: bool = True) -> dict[str, Any] | None:
    patch = {
        "verification_requested_at": None,
        "verification_code_hash": None,
        "verification_expires_at": None,
        "verification_attempts": 0,
        "updated_at": iso(),
    }
    if revoke_verified:
        patch.update({"verified": 0, "verified_by": None, "verified_at": None})
    existing = get_contact(db_path, user_id, contact_id)
    if existing is None:
        return None
    merged = {**existing, **patch}
    return update_contact(db_path, user_id, contact_id, merged)


def delete_contact(db_path, user_id: str, contact_id: str) -> bool:
    existing = get_contact(db_path, user_id, contact_id)
    if existing is None:
        return False
    db.execute(db_path, "DELETE FROM contacts WHERE id = ? AND user_id = ?", (contact_id, user_id))
    return True


def active_contacts(db_path, user_id: str) -> list[dict[str, Any]]:
    return [c for c in list_contacts(db_path, user_id, include_inactive=False)]


# -------------------------------------------------------------- incidents


def create_incident(
    db_path,
    user_id: str,
    *,
    reference: str,
    trigger_source: str = "button",
    state: str = "ARMING",
) -> dict[str, Any]:
    incident_id = new_id("inc")
    now = iso()
    db.execute(
        db_path,
        """
        INSERT INTO incidents (id, user_id, reference, state, trigger_source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (incident_id, user_id, reference, state, trigger_source, now, now),
    )
    add_incident_event(db_path, incident_id, to_state=state, detail="incident created", actor="user")
    return get_incident(db_path, user_id, incident_id)  # type: ignore[return-value]


def get_incident(db_path, user_id: str, incident_id: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(db_path, "SELECT * FROM incidents WHERE id = ? AND user_id = ?", (incident_id, user_id))
    )


def get_incident_by_reference(db_path, reference: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(db_path, "SELECT * FROM incidents WHERE reference = ?", (reference,))
    )


def find_active_incident(db_path, user_id: str) -> dict[str, Any] | None:
    """Open states: an emergency is open while any of these hold."""
    return db.row_to_dict(
        db.query_one(
            db_path,
            """
            SELECT * FROM incidents
            WHERE user_id = ? AND state IN ('ARMING','COUNTDOWN','ACTIVE','ESCALATING')
            ORDER BY created_at DESC LIMIT 1
            """,
            (user_id,),
        )
    )


def transition_incident(
    db_path,
    incident_id: str,
    to_state: str,
    *,
    from_state: str | None = None,
    detail: str | None = None,
    actor: str = "user",
    **columns: Any,
) -> None:
    now = iso()
    assignments = ["state = ?", "updated_at = ?"]
    params: list[Any] = [to_state, now]
    for key, value in columns.items():
        assignments.append(f"{key} = ?")
        params.append(value)
    params.append(incident_id)
    db.execute(db_path, f"UPDATE incidents SET {', '.join(assignments)} WHERE id = ?", params)
    add_incident_event(db_path, incident_id, from_state=from_state, to_state=to_state, detail=detail, actor=actor)


def add_incident_event(
    db_path,
    incident_id: str,
    *,
    to_state: str,
    from_state: str | None = None,
    detail: str | None = None,
    actor: str = "user",
) -> None:
    db.execute(
        db_path,
        "INSERT INTO incident_events (incident_id, from_state, to_state, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (incident_id, from_state, to_state, detail, actor, iso()),
    )


def list_incident_events(db_path, incident_id: str) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(db_path, "SELECT * FROM incident_events WHERE incident_id = ? ORDER BY id ASC", (incident_id,))
    )


def list_incidents(db_path, user_id: str, limit: int = 25) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(
            db_path,
            "SELECT * FROM incidents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )
    )


def record_incident_location(
    db_path, incident_id: str, lat: float, lng: float, accuracy: float | None, source: str
) -> None:
    db.execute(
        db_path,
        "INSERT INTO incident_locations (incident_id, lat, lng, accuracy_m, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (incident_id, lat, lng, accuracy, source, iso()),
    )
    db.execute(db_path, "UPDATE incidents SET last_location_at = ? WHERE id = ?", (iso(), incident_id))


def incident_anchor(db_path, incident_id: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(
            db_path,
            "SELECT * FROM incident_locations WHERE incident_id = ? ORDER BY id ASC LIMIT 1",
            (incident_id,),
        )
    )


# -------------------------------------------------------------- locations


def record_location_sample(
    db_path,
    user_id: str,
    *,
    lat: float,
    lng: float,
    accuracy: float | None = None,
    speed: float | None = None,
    heading: float | None = None,
    battery: int | None = None,
    incident_id: str | None = None,
    source: str = "gps",
) -> dict[str, Any]:
    row = {
        "user_id": user_id,
        "lat": lat,
        "lng": lng,
        "accuracy_m": accuracy,
        "speed_mps": speed,
        "heading_deg": heading,
        "battery_pct": battery,
        "incident_id": incident_id,
        "source": source,
        "created_at": iso(),
    }
    db.execute(
        db_path,
        """
        INSERT INTO location_samples
            (user_id, incident_id, lat, lng, accuracy_m, speed_mps, heading_deg, battery_pct, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        tuple(row[k] for k in (
            "user_id", "incident_id", "lat", "lng", "accuracy_m", "speed_mps",
            "heading_deg", "battery_pct", "source", "created_at",
        )),
    )
    return row


def latest_location(db_path, user_id: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(
            db_path,
            "SELECT * FROM location_samples WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user_id,),
        )
    )


def incident_trail(db_path, incident_id: str, limit: int = 200) -> list[dict[str, Any]]:
    rows = db.query(
        db_path,
        "SELECT lat, lng, accuracy_m, created_at FROM location_samples WHERE incident_id = ? ORDER BY created_at ASC LIMIT ?",
        (incident_id, limit),
    )
    return db.rows_to_dicts(rows)


def purge_old_locations(db_path, retention_days: int) -> int:
    """Delete non-incident location samples older than the retention window.

    Samples attached to an incident are part of the incident record and are kept
    with it, so they are excluded here. Everything else is ordinary movement
    telemetry and must not accumulate into a profile.
    """
    from datetime import timedelta

    cutoff = iso(utcnow() - timedelta(days=max(0, retention_days)))
    cur = db.execute(
        db_path,
        "DELETE FROM location_samples WHERE created_at < ? AND incident_id IS NULL",
        (cutoff,),
    )
    return cur.rowcount or 0


def purge_expired_share_tokens(db_path) -> int:
    """Remove share tokens that have expired.

    An expired token is already rejected by the guardian endpoint, so deleting it
    changes no behaviour — it only removes the hash so a leaked database cannot
    be probed for tokens that used to exist.
    """
    cur = db.execute(db_path, "DELETE FROM share_tokens WHERE expires_at < ?", (iso(),))
    return cur.rowcount or 0


def purge_stale_emergency_state(db_path, max_open_hours: int = 24) -> int:
    """Close incidents and journeys that were left open by a crashed client.

    An emergency that is still ``ARMING``/``COUNTDOWN``/``ACTIVE`` a day later is
    not a live emergency; it is an abandoned row. It is closed as ``CANCELLED``
    with an explicit reason rather than being silently kept open forever, and the
    transition is recorded so the audit trail stays complete.
    """
    from datetime import timedelta

    cutoff = iso(utcnow() - timedelta(hours=max(1, max_open_hours)))
    rows = db.rows_to_dicts(
        db.query(
            db_path,
            "SELECT id, user_id, state FROM incidents WHERE state IN ('ARMING','COUNTDOWN','ACTIVE','ESCALATING') AND COALESCE(activated_at, created_at) < ?",
            (cutoff,),
        )
    )
    for row in rows:
        transition_incident(
            db_path,
            row["id"],
            "CANCELLED",
            from_state=row["state"],
            detail="closed by retention policy — no client activity for 24 hours",
            outcome="CANCELLED",
            resolution_note="Closed automatically by the retention policy.",
            resolved_at=iso(),
        )
    db.execute(
        db_path,
        "UPDATE journeys SET state = 'CANCELLED', ended_at = ?, updated_at = ? "
        "WHERE state IN ('ON_JOURNEY','CHECK_IN_REQUIRED','WARNING') AND COALESCE(grace_until, due_at) < ?",
        (iso(), iso(), cutoff),
    )
    return len(rows)


def trim_audit_log(db_path, retention_days: int) -> int:
    """Keep the audit trail useful without letting it grow without bound.

    Incident and authentication events are the rows that matter for an
    investigation, so the window is generous and configurable.
    """
    from datetime import timedelta

    cutoff = iso(utcnow() - timedelta(days=max(1, retention_days)))
    cur = db.execute(db_path, "DELETE FROM audit_log WHERE created_at < ?", (cutoff,))
    return cur.rowcount or 0


def retention_report(db_path, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """What the retention policy currently holds, for the privacy screen."""
    config = config or {}
    counts = {
        "locationSamples": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM location_samples") or {"c": 0})["c"]),
        "incidentTrailSamples": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM location_samples WHERE incident_id IS NOT NULL") or {"c": 0})["c"]),
        "shareTokens": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM share_tokens") or {"c": 0})["c"]),
        "expiredShareTokens": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM share_tokens WHERE expires_at < ?", (iso(),)) or {"c": 0})["c"]),
        "auditRows": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM audit_log") or {"c": 0})["c"]),
        "incidents": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM incidents") or {"c": 0})["c"]),
        "notificationAttempts": int((db.query_one(db_path, "SELECT COUNT(*) AS c FROM notification_attempts") or {"c": 0})["c"]),
    }
    return {
        "counts": counts,
        "policy": {
            "nonIncidentLocationDays": config.get("INCIDENT_LOCATION_RETENTION_DAYS"),
            "shareTokenTtlSeconds": config.get("SHARE_TOKEN_DEFAULT_TTL"),
            "shareTokenMaxTtlSeconds": config.get("SHARE_TOKEN_MAX_TTL"),
            "auditRetentionDays": config.get("AUDIT_RETENTION_DAYS"),
            "cleanupIntervalSeconds": config.get("CLEANUP_INTERVAL_SECONDS"),
        },
    }


# ----------------------------------------------------------- share tokens


def create_share_token(
    db_path,
    *,
    user_id: str,
    token_hash: str,
    incident_id: str | None,
    label: str,
    scope: str,
    include_trail: bool,
    expires_at: str,
) -> str:
    token_id = new_id("shr")
    db.execute(
        db_path,
        """
        INSERT INTO share_tokens (id, token_hash, user_id, incident_id, label, scope,
                                  include_trail, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (token_id, token_hash, user_id, incident_id, label, scope, 1 if include_trail else 0, expires_at, iso()),
    )
    return token_id


def get_share_token_by_hash(db_path, token_hash: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(db_path, "SELECT * FROM share_tokens WHERE token_hash = ?", (token_hash,))
    )


def list_share_tokens(db_path, user_id: str) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(db_path, "SELECT * FROM share_tokens WHERE user_id = ? ORDER BY created_at DESC", (user_id,))
    )


def touch_share_token(db_path, token_id: str) -> None:
    db.execute(
        db_path,
        "UPDATE share_tokens SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?",
        (iso(), token_id),
    )


def revoke_share_token(db_path, user_id: str, token_id: str) -> bool:
    cur = db.execute(
        db_path,
        "UPDATE share_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        (iso(), token_id, user_id),
    )
    return bool(cur.rowcount)


# --------------------------------------------------------------- journeys


def create_journey(db_path, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
    journey_id = new_id("jrn")
    now = iso()
    db.execute(
        db_path,
        """
        INSERT INTO journeys (id, user_id, origin_label, destination_label, expected_minutes,
                              contact_id, state, started_at, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ON_JOURNEY', ?, ?, ?, ?)
        """,
        (
            journey_id,
            user_id,
            data["origin_label"],
            data["destination_label"],
            data["expected_minutes"],
            data.get("contact_id"),
            now,
            data["due_at"],
            now,
            now,
        ),
    )
    add_journey_event(db_path, journey_id, to_state="ON_JOURNEY", detail="journey started")
    return get_journey(db_path, user_id, journey_id)  # type: ignore[return-value]


def get_journey(db_path, user_id: str, journey_id: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(db_path, "SELECT * FROM journeys WHERE id = ? AND user_id = ?", (journey_id, user_id))
    )


def active_journey(db_path, user_id: str) -> dict[str, Any] | None:
    return db.row_to_dict(
        db.query_one(
            db_path,
            "SELECT * FROM journeys WHERE user_id = ? AND state IN "
            "('ON_JOURNEY','CHECK_IN_REQUIRED','WARNING') ORDER BY started_at DESC LIMIT 1",
            (user_id,),
        )
    )


def list_journeys(db_path, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(
            db_path,
            "SELECT * FROM journeys WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )
    )


def transition_journey(
    db_path,
    journey_id: str,
    to_state: str,
    *,
    from_state: str | None = None,
    detail: str | None = None,
    **columns: Any,
) -> None:
    assignments = ["state = ?", "updated_at = ?"]
    params: list[Any] = [to_state, iso()]
    for key, value in columns.items():
        assignments.append(f"{key} = ?")
        params.append(value)
    params.append(journey_id)
    db.execute(db_path, f"UPDATE journeys SET {', '.join(assignments)} WHERE id = ?", params)
    add_journey_event(db_path, journey_id, from_state=from_state, to_state=to_state, detail=detail)


def add_journey_event(db_path, journey_id: str, *, to_state: str, from_state: str | None = None, detail: str | None = None) -> None:
    db.execute(
        db_path,
        "INSERT INTO journey_events (journey_id, from_state, to_state, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        (journey_id, from_state, to_state, detail, iso()),
    )


def list_journey_events(db_path, journey_id: str) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(
            db_path,
            "SELECT * FROM journey_events WHERE journey_id = ? ORDER BY id ASC",
            (journey_id,),
        )
    )


# -------------------------------------------------------------- check-ins


def create_check_in(db_path, user_id: str, data: dict[str, Any]) -> dict[str, Any]:
    check_in_id = new_id("chk")
    db.execute(
        db_path,
        "INSERT INTO check_ins (id, user_id, journey_id, incident_id, message, place_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (check_in_id, user_id, data.get("journey_id"), data.get("incident_id"), data["message"], data.get("place_label"), iso()),
    )
    return db.row_to_dict(db.query_one(db_path, "SELECT * FROM check_ins WHERE id = ?", (check_in_id,)))


def list_check_ins(db_path, user_id: str, limit: int = 20) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(db_path, "SELECT * FROM check_ins WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", (user_id, limit))
    )


# --------------------------------------------------- community reporting

REPORT_STATES = ("COMMUNITY_REPORTED", "UNDER_REVIEW", "VERIFIED", "DISMISSED", "RESOLVED")


def create_report(db_path, data: dict[str, Any]) -> dict[str, Any]:
    report_id = new_id("rep")
    now = iso()
    db.execute(
        db_path,
        """
        INSERT INTO community_reports (id, user_id, category, title, description, place_label,
                                       lat, lng, occurred_at, anonymous, state, confidence,
                                       evidence_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMMUNITY_REPORTED', 0.0, ?, ?, ?)
        """,
        (
            report_id,
            data.get("user_id"),
            data["category"],
            data["title"],
            data.get("description"),
            data.get("place_label"),
            data.get("lat"),
            data.get("lng"),
            data.get("occurred_at"),
            1 if data.get("anonymous") else 0,
            data.get("evidence_url"),
            now,
            now,
        ),
    )
    return get_report(db_path, report_id)  # type: ignore[return-value]


def get_report(db_path, report_id: str) -> dict[str, Any] | None:
    return db.row_to_dict(db.query_one(db_path, "SELECT * FROM community_reports WHERE id = ?", (report_id,)))


def list_reports(
    db_path,
    *,
    states: tuple[str, ...] = ("COMMUNITY_REPORTED", "UNDER_REVIEW", "VERIFIED"),
    near: tuple[float, float] | None = None,
    radius_km: float | None = None,
    limit: int = 40,
) -> list[dict[str, Any]]:
    from .geo import haversine_km
    import math

    if not near or radius_km is None:
        placeholders = ",".join("?" for _ in states)
        rows = db.query(
            db_path,
            f"SELECT * FROM community_reports WHERE state IN ({placeholders}) ORDER BY created_at DESC LIMIT ?",
            (*states, limit),
        )
        reports = db.rows_to_dicts(rows)
    else:
        lat, lng = near
        lat_delta = radius_km / 111.32
        cos_lat = max(math.cos(math.radians(lat)), 1e-6)
        lng_delta = radius_km / (111.32 * cos_lat)
        placeholders = ",".join("?" for _ in states)
        rows = db.query(
            db_path,
            f"""
            SELECT * FROM community_reports
            WHERE state IN ({placeholders}) AND lat IS NOT NULL AND lng IS NOT NULL
              AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
            ORDER BY created_at DESC LIMIT ?
            """,
            (*states, lat - lat_delta, lat + lat_delta, lng - lng_delta, lng + lng_delta, limit),
        )
        reports = db.rows_to_dicts(rows)
        reports.sort(key=lambda r: haversine_km(lat, lng, r["lat"], r["lng"]))
        for report in reports:
            report["distance_km"] = round(haversine_km(lat, lng, report["lat"], report["lng"]), 3)
    for report in reports:
        report["anonymous"] = bool(report["anonymous"])
    return reports


def set_report_state(
    db_path, report_id: str, state: str, *, moderator_note: str | None = None, confidence: float | None = None
) -> dict[str, Any] | None:
    db.execute(
        db_path,
        "UPDATE community_reports SET state = ?, moderator_note = ?, confidence = ?, updated_at = ? WHERE id = ?",
        (state, moderator_note, confidence if confidence is not None else 0.0, iso(), report_id),
    )
    return get_report(db_path, report_id)


def vote_for_report(db_path, report_id: str, user_id: str) -> tuple[bool, int]:
    """Returns ``(created, helpful_count)``. One vote per user, idempotent."""
    existing = db.query_one(
        db_path, "SELECT 1 FROM report_votes WHERE report_id = ? AND user_id = ?", (report_id, user_id)
    )
    if existing:
        row = db.query_one(db_path, "SELECT helpful_count FROM community_reports WHERE id = ?", (report_id,))
        return False, int(row["helpful_count"]) if row else 0
    db.execute(
        db_path, "INSERT INTO report_votes (report_id, user_id, created_at) VALUES (?, ?, ?)", (report_id, user_id, iso())
    )
    db.execute(
        db_path, "UPDATE community_reports SET helpful_count = helpful_count + 1, updated_at = ? WHERE id = ?",
        (iso(), report_id),
    )
    row = db.query_one(db_path, "SELECT helpful_count FROM community_reports WHERE id = ?", (report_id,))
    return True, int(row["helpful_count"]) if row else 0


# --------------------------------------------------------------- cache


def cache_get(db_path, cache_key: str, ttl_seconds: int) -> Any | None:
    row = db.query_one(db_path, "SELECT payload, fetched_at FROM cached_places WHERE cache_key = ?", (cache_key,))
    if row is None:
        return None
    try:
        from datetime import datetime

        fetched = datetime.fromisoformat(row["fetched_at"])
        now = utcnow().replace(tzinfo=fetched.tzinfo) if fetched.tzinfo is None else utcnow()
        if (now - fetched).total_seconds() > ttl_seconds:
            return None
        return json.loads(row["payload"])
    except Exception:
        return None


def cache_set(db_path, cache_key: str, payload: Any, provider: str) -> None:
    db.execute(
        db_path,
        "INSERT INTO cached_places (cache_key, payload, provider, fetched_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, provider = excluded.provider, fetched_at = excluded.fetched_at",
        (cache_key, json.dumps(payload, default=str), provider, iso()),
    )


# ------------------------------------------------------- notifications


def record_notification(
    db_path,
    *,
    incident_id: str | None,
    user_id: str | None,
    contact_id: str | None,
    channel: str,
    provider: str,
    destination: str,
    body_preview: str | None,
    status: str,
    detail: str | None = None,
) -> None:
    db.execute(
        db_path,
        """
        INSERT INTO notification_attempts (incident_id, user_id, contact_id, channel, provider,
                                           destination, body_preview, status, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (incident_id, user_id, contact_id, channel, provider, destination, body_preview, status, detail, iso()),
    )


def list_notifications(db_path, incident_id: str) -> list[dict[str, Any]]:
    return db.rows_to_dicts(
        db.query(
            db_path,
            "SELECT * FROM notification_attempts WHERE incident_id = ? ORDER BY id ASC",
            (incident_id,),
        )
    )


# ------------------------------------------------------------- utilities


def _decode_json(raw: Any, fallback: Any) -> Any:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback