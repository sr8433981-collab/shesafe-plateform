"""SQLite persistence layer.

Why SQLite
----------
The project brief asked to "prefer a real relational database". PostgreSQL or
Supabase would require hosted credentials the team does not have and would
break the "runnable after every major change" rule. SQLite gives us the
*production-style* behaviours that actually matter — a normalised schema,
foreign keys, indexes, transactions, migrations and a single portable file —
with zero external dependencies and zero installation.

All SQL in this project goes through :func:`query` / :func:`execute`, which use
**parameterised statements only**. String interpolation of user input into SQL
is not possible through this API.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Sequence

_local = threading.local()

SCHEMA_VERSION = 4

#: Additive column migrations, applied on every start.
#:
#: ``CREATE TABLE IF NOT EXISTS`` cannot add a column to a table that already
#: exists, so each entry here is applied with ``ALTER TABLE ... ADD COLUMN`` when
#: the column is missing. Entries are never removed or reordered; a database that
#: has been migrated forward stays forward-compatible because every change is
#: additive and nullable or has a default.
MIGRATIONS: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = (
    (
        "users",
        (
            ("role", "TEXT NOT NULL DEFAULT 'user'"),
            ("deleted_at", "TEXT"),
        ),
    ),
    (
        "contacts",
        (
            ("verified_by", "TEXT"),
            ("verification_requested_at", "TEXT"),
            ("verification_code_hash", "TEXT"),
            ("verification_expires_at", "TEXT"),
            ("verification_attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("verified_at", "TEXT"),
        ),
    ),
)


SCHEMA = """
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT UNIQUE,
    phone           TEXT UNIQUE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user',   -- user | moderator | admin
    deleted_at      TEXT,                           -- soft delete; revokes the session immediately
    blood_group     TEXT,
    emergency_notes TEXT,
    home_area       TEXT,
    siren_enabled   INTEGER NOT NULL DEFAULT 1,
    voice_sos_enabled INTEGER NOT NULL DEFAULT 0,
    location_consent  INTEGER NOT NULL DEFAULT 0,
    share_trail_by_default INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- ------------------------------------------------------------- contacts
CREATE TABLE IF NOT EXISTS contacts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    relationship    TEXT NOT NULL DEFAULT 'Emergency Contact',
    phone           TEXT NOT NULL,
    channels        TEXT NOT NULL DEFAULT '["sms","call"]',   -- JSON array
    is_primary      INTEGER NOT NULL DEFAULT 0,
    verified        INTEGER NOT NULL DEFAULT 0,
    verified_by     TEXT,                                -- user | provider
    verified_at     TEXT,
    verification_requested_at TEXT,
    verification_code_hash    TEXT,
    verification_expires_at   TEXT,
    verification_attempts    INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

-- ------------------------------------------------------- sos incidents
CREATE TABLE IF NOT EXISTS incidents (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reference         TEXT NOT NULL UNIQUE,       -- human-facing e.g. SS-7GQ4KD
    state             TEXT NOT NULL,              -- ARMING/COUNTDOWN/ACTIVE/...
    trigger_source    TEXT NOT NULL DEFAULT 'button',  -- button | voice | journey | api
    started_at        TEXT,
    activated_at      TEXT,
    resolved_at       TEXT,
    outcome           TEXT,                       -- RESOLVED_SAFE | RESOLVED_ESCALATED | CANCELLED
    resolution_note   TEXT,
    last_location_at  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_user_state ON incidents(user_id, state);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);

-- Append-only incident event log (the audit trail of an emergency)
CREATE TABLE IF NOT EXISTS incident_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id   TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    from_state    TEXT,
    to_state      TEXT NOT NULL,
    detail        TEXT,
    actor         TEXT NOT NULL DEFAULT 'user',
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_events ON incident_events(incident_id, id);

-- Incident anchor location (first fix only) — full trails live in location_samples
CREATE TABLE IF NOT EXISTS incident_locations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id   TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    lat           REAL NOT NULL,
    lng           REAL NOT NULL,
    accuracy_m    REAL,
    source        TEXT NOT NULL DEFAULT 'gps',    -- gps | manual | simulated
    created_at    TEXT NOT NULL
);

-- ------------------------------------------------------------ locations
CREATE TABLE IF NOT EXISTS location_samples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    incident_id   TEXT REFERENCES incidents(id) ON DELETE CASCADE,
    lat           REAL NOT NULL,
    lng           REAL NOT NULL,
    accuracy_m    REAL,
    speed_mps     REAL,
    heading_deg   REAL,
    battery_pct   INTEGER,
    source        TEXT NOT NULL DEFAULT 'gps',
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_user_time ON location_samples(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_samples_incident ON location_samples(incident_id, created_at);

-- ------------------------------------------------------- share tokens
CREATE TABLE IF NOT EXISTS share_tokens (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,          -- SHA-256 of the raw token
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    incident_id   TEXT REFERENCES incidents(id) ON DELETE CASCADE,
    label         TEXT NOT NULL DEFAULT 'Live location',
    scope         TEXT NOT NULL DEFAULT 'live',  -- live | incident
    include_trail INTEGER NOT NULL DEFAULT 1,
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT,
    view_count    INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_user ON share_tokens(user_id);

-- -------------------------------------------------- journey guard
CREATE TABLE IF NOT EXISTS journeys (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin_label      TEXT NOT NULL,
    destination_label TEXT NOT NULL,
    expected_minutes  INTEGER NOT NULL,
    contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    state             TEXT NOT NULL,              -- ON_JOURNEY / CHECK_IN_REQUIRED / ...
    started_at        TEXT NOT NULL,
    due_at            TEXT NOT NULL,
    grace_until       TEXT,
    checked_in_at     TEXT,
    escalated_at      TEXT,
    escalated_incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
    ended_at          TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journeys_user_state ON journeys(user_id, state);

CREATE TABLE IF NOT EXISTS journey_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    journey_id    TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
    from_state    TEXT,
    to_state      TEXT NOT NULL,
    detail        TEXT,
    created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------- check-ins
CREATE TABLE IF NOT EXISTS check_ins (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    journey_id    TEXT REFERENCES journeys(id) ON DELETE SET NULL,
    incident_id   TEXT REFERENCES incidents(id) ON DELETE SET NULL,
    message       TEXT NOT NULL,
    place_label   TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON check_ins(user_id, created_at DESC);

-- ---------------------------------------------- community / reports
CREATE TABLE IF NOT EXISTS community_reports (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    category        TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    place_label     TEXT,
    lat             REAL,
    lng             REAL,
    occurred_at     TEXT,
    anonymous       INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'COMMUNITY_REPORTED',  -- see moderation states
    confidence      REAL NOT NULL DEFAULT 0.0,
    helpful_count   INTEGER NOT NULL DEFAULT 0,
    report_count    INTEGER NOT NULL DEFAULT 1,   -- duplicate clustering
    evidence_url    TEXT,
    moderator_note  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_state ON community_reports(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_geo ON community_reports(lat, lng);

CREATE TABLE IF NOT EXISTS report_votes (
    report_id   TEXT NOT NULL REFERENCES community_reports(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (report_id, user_id)
);

-- ------------------------------------------- notification delivery
CREATE TABLE IF NOT EXISTS notification_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id   TEXT REFERENCES incidents(id) ON DELETE CASCADE,
    user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
    contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    channel       TEXT NOT NULL,        -- sms | whatsapp | call | push
    provider      TEXT NOT NULL,        -- simulated | twilio | none
    destination   TEXT NOT NULL,
    body_preview  TEXT,
    status        TEXT NOT NULL,        -- sent | simulated | failed | unavailable | skipped
    detail        TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_incident ON notification_attempts(incident_id);

-- ------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    TEXT,
    actor_label TEXT,
    action      TEXT NOT NULL,
    outcome     TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    request_id  TEXT,
    ip_hash     TEXT,
    detail      TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- ------------------------------------------------- offline poi cache
CREATE TABLE IF NOT EXISTS cached_places (
    cache_key   TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    provider    TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _configure(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")


def get_connection(database_path: str | Path) -> sqlite3.Connection:
    """Return the request-scoped connection for this thread.

    ``:memory:`` is mapped onto a **shared-cache** in-memory database so a
    multi-threaded dev server sees one schema, not one per thread. Without this
    the threaded server would hand every worker thread a brand-new empty
    database and every query would fail.
    """
    key = str(database_path)
    conn = getattr(_local, "conn", None)
    conn_key = getattr(_local, "conn_key", None)
    if conn is not None and conn_key == key:
        return conn

    uri = False
    target = key
    if key == ":memory:":
        target = f"file:shesafe-memory-{id(_local)}?mode=memory&cache=shared"
        uri = True
    else:
        Path(key).parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(target, uri=uri, detect_types=sqlite3.PARSE_DECLTYPES, timeout=5.0)
    _configure(conn)
    _local.conn = conn
    _local.conn_key = key
    return conn


def close_connection(_exc: BaseException | None = None) -> None:  # pragma: no cover - teardown
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None
        _local.conn_key = None


def _existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def apply_migrations(conn: sqlite3.Connection) -> list[str]:
    """Add any column introduced after the database was first created.

    Returns the list of statements applied, for the boot log. Every migration is
    additive: a column is either nullable or carries a default, so an existing
    row never becomes invalid.
    """
    applied: list[str] = []
    for table, columns in MIGRATIONS:
        present = _existing_columns(conn, table)
        if not present:
            continue  # table itself does not exist yet; SCHEMA will create it
        for name, definition in columns:
            if name in present:
                continue
            statement = f"ALTER TABLE {table} ADD COLUMN {name} {definition}"
            conn.execute(statement)
            applied.append(statement)
    return applied


def init_db(database_path: str | Path) -> None:
    """Create/upgrade the schema. Idempotent."""
    conn = get_connection(database_path)
    conn.executescript(SCHEMA)
    apply_migrations(conn)
    row = conn.execute("SELECT value FROM schema_meta WHERE key = 'version'").fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES('version', ?)", (str(SCHEMA_VERSION),)
        )
    else:
        conn.execute("UPDATE schema_meta SET value = ? WHERE key = 'version'", (str(SCHEMA_VERSION),))
    conn.commit()


def query(database_path: str | Path, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
    conn = get_connection(database_path)
    return list(conn.execute(sql, tuple(params)).fetchall())


def query_one(database_path: str | Path, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
    conn = get_connection(database_path)
    return conn.execute(sql, tuple(params)).fetchone()


def execute(
    database_path: str | Path,
    sql: str,
    params: Sequence[Any] = (),
    *,
    commit: bool = True,
) -> sqlite3.Cursor:
    conn = get_connection(database_path)
    cur = conn.execute(sql, tuple(params))
    if commit:
        conn.commit()
    return cur


def executemany(database_path: str | Path, sql: str, seq: Iterable[Sequence[Any]]) -> None:
    conn = get_connection(database_path)
    conn.executemany(sql, [tuple(p) for p in seq])
    conn.commit()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]