"""Input validation.

Every write path in the API funnels through these helpers. There is no route
that trusts ``request.get_json()`` directly.
"""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from .errors import ValidationError

# --------------------------------------------------------------- regexes
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$")
PHONE_RE = re.compile(r"^[+]?[0-9][0-9\s\-().]{6,19}$")
NAME_RE = re.compile(r"^[^\x00-\x1f<>]{1,80}$")
TEXT_RE = re.compile(r"^[^\x00-\x08\x0b\x0c\x0e-\x1f]{0,2000}$")

CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

PHONE_DIGITS_RE = re.compile(r"\d+")

WEAK_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789", "qwerty123",
    "admin", "admin123", "letmein", "welcome", "iloveyou", "11111111", "00000000",
}


def _clean(value: Any) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFKC", str(value))
    return CONTROL_CHARS_RE.sub("", text).strip()


def require_json(request) -> dict[str, Any]:
    body = request.get_json(silent=True)
    if body is None:
        raise ValidationError("A JSON body is required.")
    if not isinstance(body, dict):
        raise ValidationError("The request body must be a JSON object.")
    return body


def field(
    data: dict[str, Any],
    name: str,
    *,
    required: bool = True,
    max_length: int = 200,
    min_length: int = 0,
    pattern: re.Pattern[str] | None = None,
    label: str | None = None,
    default: str | None = None,
) -> str | None:
    label = label or name.replace("_", " ").capitalize()
    raw = data.get(name)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if required:
            raise ValidationError(f"{label} is required.", **{name: "required"})
        return default
    value = _clean(raw)
    if len(value) < min_length:
        raise ValidationError(f"{label} must be at least {min_length} characters.", **{name: "too_short"})
    if len(value) > max_length:
        raise ValidationError(f"{label} must be under {max_length} characters.", **{name: "too_long"})
    if pattern and not pattern.match(value):
        raise ValidationError(f"{label} is not valid.", **{name: "invalid"})
    return value


def enum_field(
    data: dict[str, Any],
    name: str,
    allowed: Iterable[str],
    *,
    required: bool = True,
    default: str | None = None,
    label: str | None = None,
) -> str | None:
    label = label or name.replace("_", " ").capitalize()
    value = field(data, name, required=required, max_length=64, label=label, default=default)
    if value is None:
        return default
    if value not in set(allowed):
        raise ValidationError(
            f"{label} must be one of: {', '.join(sorted(allowed))}.",
            **{name: "invalid"},
        )
    return value


def email_field(data: dict[str, Any], name: str = "email", *, required: bool = True) -> str | None:
    value = field(data, name, required=required, max_length=254, label="Email address")
    if value is None:
        return None
    value = value.lower()
    if not EMAIL_RE.match(value):
        raise ValidationError("Enter a valid email address.", **{name: "invalid"})
    return value


def phone_field(data: dict[str, Any], name: str = "phone", *, required: bool = True) -> str | None:
    value = field(data, name, required=required, max_length=24, label="Phone number")
    if value is None:
        return None
    if not PHONE_RE.match(value):
        raise ValidationError("Enter a valid phone number (7-20 digits).", **{name: "invalid"})
    digits = "".join(PHONE_DIGITS_RE.findall(value))
    if not 7 <= len(digits) <= 15:
        raise ValidationError("Enter a valid phone number (7-15 digits).", **{name: "invalid"})
    return value


def normalise_phone(value: str) -> str:
    """Comparable form: digits only, with an international prefix when present."""
    digits = "".join(PHONE_DIGITS_RE.findall(value or ""))
    if value and value.strip().startswith("+"):
        return f"+{digits}"
    if len(digits) == 10:
        return f"+91{digits}"
    return digits


def mask_phone(value: str) -> str:
    digits = "".join(PHONE_DIGITS_RE.findall(value or ""))
    if len(digits) <= 4:
        return "*" * len(digits)
    return f"***{digits[-4:]}"


def password_field(data: dict[str, Any], name: str = "password") -> str:
    value = field(data, name, max_length=200, label="Password")
    if value is None or len(value) < 8:
        raise ValidationError("Password must be at least 8 characters.", password="too_short")
    if value.lower() in WEAK_PASSWORDS:
        raise ValidationError("That password is too easy to guess. Choose something stronger.", password="weak")
    if not re.search(r"[A-Za-z]", value) or not re.search(r"\d", value):
        raise ValidationError("Password must contain both letters and numbers.", password="weak")
    return value


def bool_field(data: dict[str, Any], name: str, *, default: bool = False) -> bool:
    raw = data.get(name, default)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return default


def int_field(
    data: dict[str, Any],
    name: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
    required: bool = True,
    default: int | None = None,
    label: str | None = None,
) -> int | None:
    label = label or name.replace("_", " ").capitalize()
    raw = data.get(name, default)
    if raw is None or raw == "":
        if required:
            raise ValidationError(f"{label} is required.", **{name: "required"})
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a whole number.", **{name: "invalid"}) from None
    if minimum is not None and value < minimum:
        raise ValidationError(f"{label} must be at least {minimum}.", **{name: "too_small"})
    if maximum is not None and value > maximum:
        raise ValidationError(f"{label} must be at most {maximum}.", **{name: "too_large"})
    return value


def lat_field(data: dict[str, Any], name: str = "lat", *, required: bool = True) -> float | None:
    return _coord_field(data, name, "Latitude", -90.0, 90.0, required)


def lng_field(data: dict[str, Any], name: str = "lng", *, required: bool = True) -> float | None:
    return _coord_field(data, name, "Longitude", -180.0, 180.0, required)


def _coord_field(data, name, label, lo, hi, required) -> float | None:
    raw = data.get(name)
    if raw is None or raw == "":
        if required:
            raise ValidationError(f"{label} is required.", **{name: "required"})
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a number.", **{name: "invalid"}) from None
    if math.isnan(value) or math.isinf(value):
        raise ValidationError(f"{label} must be a real number.", **{name: "invalid"})
    if not lo <= value <= hi:
        raise ValidationError(f"{label} must be between {lo} and {hi}.", **{name: "out_of_range"})
    return value


def accuracy_field(data: dict[str, Any], name: str = "accuracy", *, maximum: float = 5000.0) -> float | None:
    """GPS accuracy in metres.

    Anything outside a physically possible range (greater than 5 km) is rejected
    rather than silently dropped, so a hostile or broken client cannot make
    SheSafe record a meaningless fix.
    """
    raw = data.get(name)
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValidationError("Accuracy must be a number in metres.", accuracy="invalid") from None
    if math.isnan(value) or math.isinf(value):
        raise ValidationError("Accuracy must be a real number.", accuracy="invalid")
    if value < 0:
        raise ValidationError("Accuracy cannot be negative.", accuracy="invalid")
    if value > maximum:
        raise ValidationError(
            f"Accuracy of {int(value)}m is not a usable GPS fix.", accuracy="out_of_range"
        )
    return value


def optional_text(data: dict[str, Any], name: str, *, max_length: int = 2000) -> str | None:
    return field(data, name, required=False, max_length=max_length, default=None)


def parse_iso_datetime(value: Any, *, field_name: str = "timestamp") -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = _clean(value)
    if not text:
        raise ValidationError("A timestamp is required.", **{field_name: "required"})
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError("Timestamp must be ISO-8601.", **{field_name: "invalid"}) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def clamp_ttl(seconds: int, *, maximum: int) -> int:
    return max(60, min(int(seconds), maximum))


def future_iso(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def query_float(args, name: str, *, lo: float, hi: float, default: float | None = None) -> float | None:
    raw = args.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{name} must be a number.", **{name: "invalid"}) from None
    if math.isnan(value) or math.isinf(value):
        raise ValidationError(f"{name} must be a real number.", **{name: "invalid"})
    return max(lo, min(hi, value))


def query_int(args, name: str, *, lo: int, hi: int, default: int) -> int:
    raw = args.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValidationError(f"{name} must be a whole number.", **{name: "invalid"}) from None
    return max(lo, min(hi, value))