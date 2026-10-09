"""One timeline vocabulary for the whole product.

A safety product is judged on its record. Every surface that tells a person
*what happened* — the owner's dashboard, incident history, and the guardian
console someone else is watching — needs the same four facts for every event:

``at``           the timestamp,
``type``         what kind of thing happened (``sos``, ``location``, ``notification``, ...),
``status``       whether it happened, and in what state (``active``, ``delivered``, ``failed``, ...),
``explanation``  a sentence a person can read without knowing the state machine.

Two rules make that trustworthy:

1. **Events are derived from stored rows, never predicted.** A step that has not
   happened is omitted rather than shown optimistically, so a timeline can never
   imply a notification that was not attempted.
2. **The wording is generated, not hand-written per call site.** The same
   ``ARMING -> COUNTDOWN`` transition produces the same sentence in the
   dashboard, in history and in the guardian console.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

#: Event families. A timeline is sorted by time, so the type is for grouping and
#: for choosing an icon, never for ordering.
TYPES = (
    "sos",          # the emergency lifecycle itself
    "location",     # a position was captured or stopped
    "sharing",      # a tracking link was minted, used or revoked
    "notification", # a contact alert attempt, with its real outcome
    "journey",      # Journey Guard state changes
    "checkin",      # the user said they arrived
    "route",        # a safety-aware route recommendation
    "community",    # a community report was filed or moderated
)

#: Status vocabulary. Every status in the product is one of these, so a colour is
#: never the only thing distinguishing two events.
STATUSES = (
    "pending",   # expected but not yet done
    "active",    # happening now
    "delivered", # confirmed by a provider
    "simulated", # recorded, but nothing left the building
    "failed",    # attempted and did not succeed
    "unavailable",  # no provider exists for this channel
    "skipped",   # deliberately not attempted
    "closed",    # finished successfully
    "cancelled", # finished without completing
)

#: ``to_state`` -> (type, status, human explanation). Anything not listed falls
#: back to ``_fallback`` so a new state can never render as a blank row.
LIFECYCLE: dict[str, dict[str, str]] = {
    "ARMING": {
        "type": "sos",
        "status": "active",
        "label": "SOS arming",
        "explanation": "The emergency was requested. Nothing had been sent to anyone yet.",
    },
    "COUNTDOWN": {
        "type": "sos",
        "status": "active",
        "label": "Cancel window open",
        "explanation": "The alert was armed and a cancel window opened. No contact had been alerted.",
    },
    "ACTIVE": {
        "type": "sos",
        "status": "active",
        "label": "SOS activated",
        "explanation": "The incident became active. SheSafe recorded it and attempted to alert trusted contacts.",
    },
    "ESCALATING": {
        "type": "sos",
        "status": "active",
        "label": "Escalating",
        "explanation": "The situation was marked as getting worse. SheSafe still has not contacted emergency services.",
    },
    "RESOLVED": {
        "type": "sos",
        "status": "closed",
        "label": "Stood down safely",
        "explanation": "The person confirmed they were safe. Contacts were recorded as told.",
    },
    "CANCELLED": {
        "type": "sos",
        "status": "cancelled",
        "label": "Cancelled",
        "explanation": "The emergency was called off.",
    },
}

JOURNEY_LIFECYCLE: dict[str, dict[str, str]] = {
    "ON_JOURNEY": {
        "type": "journey",
        "status": "active",
        "label": "Journey started",
        "explanation": "Journey Guard started counting down to the expected arrival.",
    },
    "CHECK_IN_REQUIRED": {
        "type": "journey",
        "status": "pending",
        "label": "Check-in due",
        "explanation": "The expected arrival time was reached, so SheSafe asked whether the person arrived.",
    },
    "WARNING": {
        "type": "journey",
        "status": "failed",
        "label": "No check-in received",
        "explanation": "Nobody checked in. No contact was alerted automatically — the person escalates, or nothing happens.",
    },
    "EMERGENCY": {
        "type": "sos",
        "status": "active",
        "label": "Escalated to SOS",
        "explanation": "The journey was escalated into a real SOS incident and contacts were alerted.",
    },
    "ARRIVED": {
        "type": "checkin",
        "status": "closed",
        "label": "Arrived safely",
        "explanation": "The person checked in and the journey was closed.",
    },
    "CANCELLED": {
        "type": "journey",
        "status": "cancelled",
        "label": "Journey cancelled",
        "explanation": "Journey Guard stopped before it escalated.",
    },
}

#: Notification delivery status -> timeline status and wording.
DELIVERY_STATUS = {
    "sent": ("delivered", "confirmed delivered"),
    "simulated": ("simulated", "recorded as SIMULATED — no external message was sent"),
    "failed": ("failed", "the provider reported a failure"),
    "unavailable": ("unavailable", "no notification provider is configured for this channel"),
    "skipped": ("skipped", "this channel was deliberately not used"),
}


def event(
    at: str | None,
    state: str,
    *,
    table: dict[str, dict[str, str]] | None = None,
    detail: str | None = None,
    actor: str | None = None,
    category: str | None = None,
) -> dict[str, Any]:
    """Normalise one stored row into the shared timeline shape."""
    table = table if table is not None else LIFECYCLE
    spec = table.get(state) or _fallback(state)
    return {
        "at": at,
        "state": state,
        "type": category or spec["type"],
        "status": spec["status"],
        "label": spec["label"],
        "explanation": detail or spec["explanation"],
        "actor": actor,
        "detail": detail,
    }


def _fallback(state: str) -> dict[str, str]:
    # A state the vocabulary does not know about is still shown, with the raw
    # state visible. Silently dropping it would hide a row from the record.
    return {
        "type": "sos",
        "status": "active",
        "label": str(state).replace("_", " ").title(),
        "explanation": f"Recorded state: {state}.",
    }


def notification_event(row: dict[str, Any]) -> dict[str, Any]:
    """One contact-alert attempt, described by what actually happened."""
    status, wording = DELIVERY_STATUS.get(
        str(row.get("status") or "unavailable"), ("unavailable", "the delivery outcome was not recorded")
    )
    channel = str(row.get("channel") or "message").upper()
    return {
        "at": row.get("created_at"),
        "state": f"NOTIFY_{str(row.get('status') or 'unavailable').upper()}",
        "type": "notification",
        "status": status,
        "label": f"Contact alert · {channel}",
        "explanation": f"{channel} to a trusted contact was {wording}.",
        "actor": row.get("provider") or "shesafe",
        "detail": row.get("detail"),
        "channel": row.get("channel"),
        "provider": row.get("provider"),
    }


def location_event(row: dict[str, Any], *, label: str | None = None) -> dict[str, Any]:
    accuracy = row.get("accuracy_m")
    accuracy_text = f" at ±{int(accuracy)}m accuracy" if accuracy is not None else ""
    return {
        "at": row.get("created_at"),
        "state": "LOCATION",
        "type": "location",
        "status": "active",
        "label": label or "Position captured",
        "explanation": f"SheSafe received a position{accuracy_text} and recorded it with the incident.",
        "actor": row.get("source") or "gps",
        "detail": None,
    }


def sharing_events(row: dict[str, Any]) -> list[dict[str, Any]]:
    """The link's whole life: created, and - if it was revoked - revoked.

    Returning both matters for the causal reading. A single event derived from
    the row's current state flipped to "Tracking link revoked" the moment the
    link closed and silently dropped the fact that it had once been live.
    """
    created = {
        "at": row.get("created_at"),
        "state": "SHARED",
        "type": "sharing",
        "status": "active",
        "label": "Live tracking link created",
        "explanation": "An expiring live-tracking link was created so trusted people could follow the position.",
        "actor": "user",
        "detail": row.get("label"),
    }
    if not row.get("revoked_at"):
        return [created]
    return [
        created,
        {
            "at": row.get("revoked_at"),
            "state": "REVOKED",
            "type": "sharing",
            "status": "cancelled",
            "label": "Tracking link revoked",
            "explanation": "The tracking link was revoked. It stops working immediately.",
            "actor": "user",
            "detail": row.get("label"),
        },
    ]


def merge(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Combine event sources into one time-ordered, de-duplicated timeline.

    Ordering is by timestamp, with **insertion order** as the tie-break. Two
    events written in the same second — a state change and the check-in recorded
    alongside it — must stay in the order they happened, and an alphabetical
    tie-break would silently reorder a journey's history.
    """
    merged: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for group in groups:
        for item in group or []:
            if not item:
                continue
            identity = (item.get("at"), item.get("state"), item.get("label"), item.get("explanation"))
            if identity in seen:
                continue
            seen.add(identity)
            merged.append(item)
    merged.sort(key=_sort_key)
    return merged


def _sort_key(item: dict[str, Any]) -> tuple[int, float]:
    parsed = parse(item.get("at"))
    # Undated events sort first so the record still reads top to bottom.
    # Python's sort is stable, so events sharing a timestamp keep the order they
    # were passed in — which is the order they were written.
    return (0 if parsed else 1, parsed.timestamp() if parsed else 0.0)


def parse(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")