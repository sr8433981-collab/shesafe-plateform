"""Nearby safe places.

Real data only. Places come from **OpenStreetMap via the Overpass API**, which is
free, key-free, and crowd-maintained. Nothing is invented: if we cannot reach a
provider, the API says so and falls back to official helplines plus a deep link
out to a map search — never to a fabricated business.

Provenance is explicit on every record:
``openstreetmap`` (real), ``simulated_demo_dataset`` (Demo Mode only), or absent.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from .. import geo, repo as repo_mod

CATEGORY_RULES: list[dict[str, Any]] = [
    {
        "category": "police",
        "label": "Police",
        "icon": "police",
        "query": 'nwr["amenity"="police"]',
        "radius": 5000,
        "utility": 1.0,
    },
    {
        "category": "hospital",
        "label": "Hospital / Emergency care",
        "icon": "hospital",
        "query": 'nwr["amenity"~"^(hospital|clinic|doctors)$"]',
        "radius": 5000,
        "utility": 0.85,
    },
    {
        "category": "pharmacy",
        "label": "Pharmacy",
        "icon": "pharmacy",
        "query": 'nwr["amenity"~"^(pharmacy|chemist)$"]',
        "radius": 3500,
        "utility": 0.5,
    },
    {
        "category": "shelter",
        "label": "Shelter / Safe accommodation",
        "icon": "shelter",
        "query": 'nwr["amenity"="shelter"]',
        "radius": 8000,
        "utility": 0.75,
    },
    {
        "category": "women_centre",
        "label": "Women's support / One-stop centre",
        "icon": "women_centre",
        "query": (
            'nwr["office"="women"]'
            '["social_facility"="women"]'
            '["name"~"[Ww]omen|[Ss]akhi|[Oo]ne[- ]?[Ss]top",i]'
            '["amenity"="community_centre"]'
        ),
        "radius": 10000,
        "utility": 0.9,
    },
    {
        "category": "safe_public",
        "label": "Safe public location",
        "icon": "safe_public",
        "query": 'nwr["amenity"="bus_station"]',
        "radius": 4000,
        "utility": 0.45,
    },
    {
        "category": "emergency_service",
        "label": "Emergency service",
        "icon": "emergency",
        "query": 'nwr["emergency"~"^(fire_rescue|phone|defibrillator|police)$"]',
        "radius": 8000,
        "utility": 0.95,
    },
]

CATEGORY_META = {r["category"]: r for r in CATEGORY_RULES}

def _haversine(lat1, lon1, lat2, lon2) -> float:
    return geo.haversine_km(lat1, lon1, lat2, lon2)


def _fmt(value: float) -> str:
    return f"{value:.5f}"


def _build_overpass_query(entries: list[dict[str, Any]], lat: float, lng: float) -> str:
    statements = "\n".join(
        f"  {rule['query']}(around:{rule['radius']},{_fmt(lat)},{_fmt(lng)});" for rule in entries
    )
    return f"[out:json][timeout:20];\n(\n{statements}\n);\nout center tags 120;"


# --- circuit breaker -------------------------------------------------------
# Public Overpass mirrors are frequently rate-limited or down. Without a breaker,
# a screen that evaluates several points would multiply the timeout and make the
# app feel broken. After a full failure we stop trying for a cool-down window.
_BREAKER_LOCK = threading.Lock()
_BREAKER: dict[str, float] = {}
BREAKER_COOLDOWN_SECONDS = 90.0


def _breaker_open() -> bool:
    with _BREAKER_LOCK:
        until = _BREAKER.get("until", 0.0)
        if until and until > time.monotonic():
            return True
        _BREAKER.pop("until", None)
        return False


def _trip_breaker() -> None:
    with _BREAKER_LOCK:
        _BREAKER["until"] = time.monotonic() + BREAKER_COOLDOWN_SECONDS


def _close_breaker() -> None:
    with _BREAKER_LOCK:
        _BREAKER.pop("until", None)


def _fetch_overpass(entries: list[dict[str, Any]], lat: float, lng: float, mirrors: list[str], timeout: float) -> dict[str, Any] | None:
    query = _build_overpass_query(entries, lat, lng)
    if _breaker_open():
        return {"__error__": "circuit breaker open (previous Overpass attempt failed)"}
    payload = urllib.parse.urlencode({"data": query}).encode()
    errors: list[str] = []
    for mirror in mirrors:
        req = urllib.request.Request(mirror, data=payload, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("User-Agent", "SheSafe/1.0 (safety routing research prototype)")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read().decode("utf-8", "replace")
            _close_breaker()
            return json.loads(raw)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
            errors.append(f"{urllib.parse.urlparse(mirror).netloc}: {exc.__class__.__name__}")
            continue
    # A mirror that is up but has no data returns valid JSON; only a total
    # transport failure trips the breaker.
    _trip_breaker()
    return {"__error__": "; ".join(errors) or "overpass unavailable"}


def _tags_of(element: dict[str, Any]) -> dict[str, str]:
    return element.get("tags") or {}


def _category_of(tags: dict[str, str]) -> str | None:
    amenity = tags.get("amenity", "")
    if amenity == "police":
        return "police"
    if amenity in {"hospital", "clinic", "doctors"}:
        return "hospital"
    if amenity in {"pharmacy", "chemist"}:
        return "pharmacy"
    if amenity == "shelter":
        return "shelter"
    if amenity == "community_centre":
        name = (tags.get("name") or "").lower()
        if any(token in name for token in ("women", "sakhi", "one-stop", "one stop", "mahila", "nari")):
            return "women_centre"
        return "safe_public"
    if amenity in {"police", "fire_station"} or "emergency" in tags:
        return "emergency_service"
    return None


DAY_CODES = ("mo", "tu", "we", "th", "fr", "sa", "su")


def _parse_hhmm(value: str) -> int | None:
    value = value.strip()
    if value in {"24", "24:00"}:
        return 24
    bits = value.split(":")
    if bits[0].isdigit() and 0 <= int(bits[0]) <= 24:
        return int(bits[0])
    return None


def _spec_matches_day(spec: str, weekday: int) -> bool:
    """Match a single day code or a `Mo-Fr` / `Mo,We,Fr` style day selector."""
    spec = spec.strip().lower()
    if "-" in spec:
        start, _, end = spec.partition("-")
        if start in DAY_CODES and end in DAY_CODES:
            s, e = DAY_CODES.index(start), DAY_CODES.index(end)
            return s <= weekday <= e if s <= e else (weekday >= s or weekday <= e)
        return False
    if "," in spec:
        return weekday in [DAY_CODES.index(d.strip()) for d in spec.split(",") if d.strip() in DAY_CODES]
    return spec in DAY_CODES and DAY_CODES.index(spec) == weekday


def _open_state(tags: dict[str, str], hour_local: int) -> tuple[str | None, bool | None]:
    """Return ``(state, is_247)`` where state is ``'open' | 'closed' | 'unknown'``.

    Only the small subset of the ``opening_hours`` grammar that OSM actually uses
    for these facilities is understood. Anything unrecognised returns ``unknown``
    so the UI never claims a facility is open when we cannot verify it.
    """
    raw = (tags.get("opening_hours") or "").strip()
    if not raw:
        return None, None
    lowered = raw.lower()
    if "24/7" in lowered or lowered in {"always", "open"}:
        return "open", True

    weekday = datetime.now(timezone.utc).weekday()
    is_247 = False
    matched_today = False

    for clause in (c.strip() for c in raw.split(";")):
        if "-" not in clause:
            continue
        day_spec, _, hours_spec = clause.partition("-")
        day_spec = day_spec.strip().lower()
        if day_spec in {"24/7", ""}:
            is_247 = True
            continue
        if not _spec_matches_day(day_spec, weekday):
            continue
        matched_today = True
        for window in hours_spec.split(","):
            bits = window.strip().split("-")
            if len(bits) != 2:
                continue
            start_h = _parse_hhmm(bits[0])
            end_h = _parse_hhmm(bits[1])
            if start_h is None or end_h is None:
                continue
            if start_h == end_h:
                is_247 = True
            elif start_h <= hour_local < end_h:
                return "open", False

    if is_247:
        return "open", True
    return ("closed" if matched_today else "unknown"), False


def _contact(tags: dict[str, str]) -> dict[str, str | None]:
    phone = tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile")
    emergency = tags.get("emergency") if tags.get("amenity") == "police" else None
    if not phone and emergency and emergency.isdigit():
        phone = emergency
    website = tags.get("website") or tags.get("contact:website")
    return {"phone": phone, "website": website}


def fetch_places(
    *,
    db_path,
    lat: float,
    lng: float,
    config,
    max_radius_km: float = 10.0,
    categories: list[str] | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    """Return nearby places with an explicit provenance block."""
    categories = categories or [r["category"] for r in CATEGORY_RULES]
    entries = [CATEGORY_META[c] for c in categories if c in CATEGORY_META]
    cache_key = f"places:{round(lat, 3)}:{round(lng, 3)}:{','.join(sorted(categories))}"

    provider_name = (config.get("PLACES_PROVIDER") or "overpass").lower()
    if provider_name == "none":
        return {
            "places": [],
            "provenance": {"provider": "none", "mode": "unavailable", "note": "Place lookup disabled by configuration."},
            "fetchedAt": None,
        }

    if use_cache:
        cached = repo_mod.cache_get(db_path, cache_key, int(config.get("PLACES_CACHE_TTL", 900)))
        if cached:
            cached["provenance"] = {**cached.get("provenance", {}), "cached": True}
            return cached

    hour_local = geo.local_hour()
    places: list[dict[str, Any]] = []
    errors: list[str] = []

    raw = _fetch_overpass(
        entries, lat, lng, list(config.get("OVERPASS_MIRRORS") or []), float(config.get("EXTERNAL_HTTP_TIMEOUT", 8.0))
    )
    if raw is None or "__error__" in (raw or {}):
        errors.append((raw or {}).get("__error__", "no response"))
    else:
        for element in raw.get("elements", []):
            center = element.get("center") or element
            plat = center.get("lat")
            plng = center.get("lon")
            if plat is None or plng is None:
                continue
            tags = _tags_of(element)
            category = _category_of(tags)
            if category is None:
                continue
            distance = _haversine(lat, lng, plat, plng)
            if distance > max_radius_km:
                continue
            name = tags.get("name") or tags.get("name:en") or CATEGORY_META[category]["label"]
            state, is_247 = _open_state(tags, hour_local)
            contact = _contact(tags)
            places.append(
                {
                    "id": f"osm_{element.get('type','node')}_{element.get('id')}",
                    "name": name,
                    "category": category,
                    "categoryLabel": CATEGORY_META[category]["label"],
                    "lat": plat,
                    "lng": plng,
                    "address": _address_line(tags),
                    "distanceKm": round(distance, 3),
                    "distanceText": geo.format_distance(distance),
                    "etaMinutesWalk": geo.eta_minutes(distance, "walk"),
                    "etaMinutesDrive": geo.eta_minutes(distance, "drive"),
                    "phone": contact["phone"],
                    "website": contact["website"],
                    "openState": state,
                    "is247": is_247,
                    "openingHours": tags.get("opening_hours"),
                    "womenFriendly": bool(tags.get("women") or tags.get("female") or category == "women_centre"),
                    "provenance": "openstreetmap",
                    "verification": "crowdsourced",
                }
            )

    places.sort(key=lambda p: p["distanceKm"])
    payload: dict[str, Any] = {
        "places": places[:80],
        "provenance": {
            "provider": "openstreetmap-overpass",
            "mode": "real" if places or not errors else "unavailable",
            "note": (
                "Places are crowd-maintained OpenStreetMap data. Inclusion does not imply "
                "an official safety endorsement; opening hours are unverified unless the "
                "tag is explicit."
            )
            if places
            else "Overpass did not respond. No places are shown rather than showing invented ones."
        },
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "errors": errors,
    }
    if places or not errors:
        try:
            repo_mod.cache_set(db_path, cache_key, payload, "overpass")
        except Exception:  # pragma: no cover - cache must never break the response
            pass
    return payload


def _address_line(tags: dict[str, str]) -> str:
    parts = [
        tags.get("addr:housenumber", "").strip(),
        tags.get("addr:street", "").strip(),
        tags.get("addr:suburb", "").strip() or tags.get("addr:city", "").strip(),
    ]
    line = ", ".join(p for p in parts if p)
    return line or None


def demo_places(lat: float, lng: float) -> dict[str, Any]:
    """SIMULATED dataset for Demo Mode only.

    Clearly labelled ``simulated_demo_dataset`` on every record. Used when the
    device has no internet so a judge demo never dead-ends — never presented as
    real. Names are generic facility *types*, not real businesses.
    """
    offsets = [
        ("police", "Demo Police Station (simulated)", 0.0090, 0.0070, "+91 100"),
        ("hospital", "Demo District Hospital (simulated)", 0.0140, 0.0120, "+91 108"),
        ("pharmacy", "Demo 24/7 Pharmacy (simulated)", 0.0050, -0.0040, None),
        ("women_centre", "Demo One-Stop Women's Centre (simulated)", -0.0065, 0.0055, "+91 181"),
        ("shelter", "Demo Safe Shelter (simulated)", -0.0115, -0.0085, None),
        ("safe_public", "Demo Well-lit Public Area (simulated)", 0.0030, 0.0120, None),
    ]
    places = []
    for index, (category, name, dlat, dlng, phone) in enumerate(offsets):
        plat, plng = round(lat + dlat, 6), round(lng + dlng, 6)
        distance = _haversine(lat, lng, plat, plng)
        meta = CATEGORY_META.get(category, CATEGORY_META["safe_public"])
        places.append(
            {
                "id": f"demo_place_{index}",
                "name": name,
                "category": category,
                "categoryLabel": meta["label"],
                "lat": plat,
                "lng": plng,
                "address": "Synthetic demo coordinate (not a real address)",
                "distanceKm": round(distance, 3),
                "distanceText": geo.format_distance(distance),
                "etaMinutesWalk": geo.eta_minutes(distance, "walk"),
                "etaMinutesDrive": geo.eta_minutes(distance, "drive"),
                "phone": phone,
                "website": None,
                "openState": "open" if category in {"hospital", "police", "pharmacy", "emergency_service"} else "unknown",
                "is247": category in {"hospital", "police", "pharmacy", "emergency_service"},
                "openingHours": None,
                "womenFriendly": category in {"women_centre", "hospital", "shelter"},
                "provenance": "simulated_demo_dataset",
                "verification": "simulated",
            }
        )
    return {
        "places": places,
        "provenance": {
            "provider": "simulated_demo_dataset",
            "mode": "simulated",
            "note": (
                "DEMO MODE. These are synthetic facilities at generated coordinates. "
                "They do not exist. Use a device with internet for real OpenStreetMap results."
            ),
        },
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "errors": [],
    }