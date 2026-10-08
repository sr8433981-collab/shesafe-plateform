"""Geospatial helpers (single implementation, used everywhere).

Haversine on a spherical earth is accurate to ~0.3% which is far finer than the
precision any consumer GPS produces, so it is the right tool here and needs no
dependency.
"""

from __future__ import annotations

import math
from typing import Iterable

EARTH_RADIUS_KM = 6371.0088
EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000.0

WALK_KMH = 4.8
CYCLE_KMH = 15.0
CAR_KMH = 26.0  # conservative urban average including signals


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return haversine_km(lat1, lon1, lat2, lon2) * 1000.0


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def path_length_km(points: Iterable[tuple[float, float]]) -> float:
    pts = list(points)
    total = 0.0
    for (lat1, lon1), (lat2, lon2) in zip(pts, pts[1:]):
        total += haversine_km(lat1, lon1, lat2, lon2)
    return total


def bbox(lat: float, lng: float, radius_km: float) -> tuple[float, float, float, float]:
    """Bounding box for an Overpass ``around`` equivalent ``(s,w,n,e)`` query."""
    dlat = radius_km / 111.32
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    dlng = radius_km / (111.32 * cos_lat)
    return (max(lat - dlat, -85.0), max(lng - dlng, -180.0), min(lat + dlat, 85.0), min(lng + dlng, 180.0))


def is_valid_coord(lat: Any, lng: Any) -> bool:
    try:
        flat, flng = float(lat), float(lng)
    except (TypeError, ValueError):
        return False
    if math.isnan(flat) or math.isnan(flng) or math.isinf(flat) or math.isinf(flng):
        return False
    return -90 <= flat <= 90 and -180 <= flng <= 180


def format_distance(km: float) -> str:
    if km < 1:
        return f"{int(round(km * 1000 / 10) * 10)} m"
    if km < 10:
        return f"{km:.1f} km"
    return f"{int(round(km))} km"


def eta_minutes(km: float, mode: str = "walk") -> int:
    speeds = {"walk": WALK_KMH, "cycle": CYCLE_KMH, "drive": CAR_KMH}
    speed = speeds.get(mode, WALK_KMH)
    return max(1, int(round(km / speed * 60)))


def is_night(dt_hour_local: int) -> bool:
    return dt_hour_local >= 20 or dt_hour_local < 6


def local_hour(moment=None, tz_offset_hours: float = 5.5) -> int:
    """Local hour for a UTC datetime. Default offset is IST (+05:30).

    The offset is configurable because the backend may be deployed outside India;
    ``SHESAFE_TZ_OFFSET`` is applied by the caller.
    """
    from datetime import datetime, timedelta, timezone

    if moment is None:
        moment = datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    offset = timezone(timedelta(hours=tz_offset_hours))
    return moment.astimezone(offset).hour


def interpolate(start: tuple[float, float], end: tuple[float, float], fraction: float) -> tuple[float, float]:
    return (start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction)


def densify(points: list[tuple[float, float]], max_segment_km: float = 0.05) -> list[tuple[float, float]]:
    """Insert intermediate points so a straight line follows Earth's curvature."""
    if len(points) < 2:
        return points
    out: list[tuple[float, float]] = [points[0]]
    for (lat1, lon1), (lat2, lon2) in zip(points, points[1:]):
        dist = haversine_km(lat1, lon1, lat2, lon2)
        steps = max(1, int(dist / max_segment_km))
        for i in range(1, steps + 1):
            out.append(interpolate((lat1, lon1), (lat2, lon2), i / steps))
    return out