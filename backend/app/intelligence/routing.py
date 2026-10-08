"""Safe Route.

Real road geometry comes from **OSRM** (the reference routing engine used by
mapillary-like projects and available as a free public demo server). SheSafe
asks OSRM for the main route *and* genuine alternatives, then scores each
alternative with the same explainable risk engine used everywhere else.

Honesty rules baked in:

* The provider's geometry/duration/distance are real, and labelled
  ``provider: osrm`` with the response's own route weight ordering.
* If OSRM cannot be reached, we do **not** invent a road network. We return an
  explicitly ``SIMULATED`` straight-line estimate so the UI still works, and the
  provenance block says so.
* "Safest route" means *lower modelled risk under these rules*, never
  "guaranteed safe".
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .. import geo

OSRM_BASE = "https://router.project-osrm.org"
SIMULATED = "simulated_geometric"


class RoutingUnavailable(Exception):
    pass


def _coord(lat: float, lng: float) -> str:
    # OSRM expects lon,lat
    return f"{lng:.6f},{lat:.6f}"


def fetch_osrm_routes(
    *,
    origin: tuple[float, float],
    destination: tuple[float, float],
    timeout: float = 8.0,
    max_alternates: int = 3,
) -> dict[str, Any]:
    """Ask OSRM for up to ``max_alternates + 1`` genuine route options."""
    coords = f"{_coord(*origin)};{_coord(*destination)}"
    url = (
        f"{OSRM_BASE}/route/v1/driving/{coords}"
        f"?alternatives={max_alternates}&geometries=geojson&overview=full&steps=false"
    )
    req = urllib.request.Request(url, method="GET")
    req.add_header("User-Agent", "SheSafe/1.0 (safety routing prototype)")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
        raise RoutingUnavailable(f"{exc.__class__.__name__}") from exc

    if payload.get("code") != "Ok":
        raise RoutingUnavailable(str(payload.get("code") or "unknown"))

    routes: list[dict[str, Any]] = []
    for index, route in enumerate(payload.get("routes", [])):
        geometry = (route.get("geometry") or {}).get("coordinates") or []
        # OSRM returns lon,lat; SheSafe stores/uses lat,lng.
        points = [(pt[1], pt[0]) for pt in geometry]
        if len(points) < 2:
            continue
        routes.append(
            {
                "providerId": str(route.get("route_index", index)),
                "distanceKm": round(float(route.get("distance", 0)) / 1000.0, 3),
                "durationMin": round(float(route.get("duration", 0)) / 60.0, 1),
                "weight": float(route.get("weight", 0)),
                "geometry": [[round(la, 5), round(lo, 5)] for la, lo in points],
                "isMain": index == 0,
                "tags": {},
            }
        )
    if not routes:
        raise RoutingUnavailable("no geometry returned")
    return {"provider": "osrm", "routes": routes}


def simulated_routes(
    origin: tuple[float, float], destination: tuple[float, float]
) -> dict[str, Any]:
    """Offline fallback: straight-line corridors at three bearings.

    Explicitly SIMULATED. There is no road-network knowledge here, so these are
    labelled as geometric estimates and are never presented as drivable routes.
    """
    direct = geo.haversine_km(*origin, *destination)
    corridors = [
        ("Direct corridor", origin, destination, 1.0),
        ("Northern corridor", _offset(origin, destination, 0.10, 0.16), destination, 1.14),
        ("Southern corridor", _offset(origin, destination, -0.10, -0.16), destination, 1.18),
    ]
    routes = []
    for name, start, end, factor in corridors:
        points = geo.densify([start, end], max_segment_km=1.0)
        distance = max(geo.path_length_km(points), direct * 0.05)
        routes.append(
            {
                "providerId": name,
                "distanceKm": round(distance, 2),
                "durationMin": round(distance / geo.WALK_KMH * 60 + 1, 1),
                "weight": round(distance, 2),
                "geometry": [[round(la, 5), round(lo, 5)] for la, lo in points],
                "isMain": name == "Direct corridor",
                "tags": {"simulated": True},
                "label": name,
            }
        )
    return {"provider": SIMULATED, "routes": routes}


def _offset(
    start: tuple[float, float], end: tuple[float, float], lat_fraction: float, lng_fraction: float
) -> tuple[float, float]:
    mid_lat = (start[0] + end[0]) / 2.0
    mid_lng = (start[1] + end[1]) / 2.0
    span_lat = end[0] - start[0]
    span_lng = end[1] - start[1]
    # Perpendicular offset scaled to the corridor length.
    return (mid_lat + lat_fraction * abs(span_lat) - lat_fraction * span_lat, mid_lng + lng_fraction * abs(span_lng) - lng_fraction * span_lng)


def sample_route_points(geometry: list[tuple[float, float]], count: int = 25) -> list[tuple[float, float]]:
    """Evenly spaced sample points along a polyline, for risk evaluation."""
    if len(geometry) < 2:
        return list(geometry)
    if len(geometry) <= count:
        return list(geometry)
    step = (len(geometry) - 1) / (count - 1)
    return [geometry[int(round(i * step))] for i in range(count)]


def midpoint(geometry: list[tuple[float, float]]) -> tuple[float, float]:
    if not geometry:
        raise ValueError("empty geometry")
    return geometry[len(geometry) // 2]


def tag_route(geometry: list[tuple[float, float]]) -> dict[str, Any]:
    """Best-effort, honest route characteristics.

    We only claim what we can compute from geometry. Lighting and CCTV are
    deliberately absent rather than guessed.
    """
    tags: dict[str, Any] = {}
    total_km = geo.path_length_km(geometry)
    straight_km = geo.haversine_km(*geometry[0], *geometry[-1])
    if straight_km > 0:
        tags["detourRatio"] = round(total_km / straight_km, 3)
        tags["indirect"] = total_km / straight_km > 1.25
    tags["lit"] = None  # unknown: we have no lighting dataset
    tags["cameras"] = None  # unknown
    tags["waterCrossing"] = False  # unknown, not asserted as safe
    return tags


def label_routes(scored: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign FASTEST / SAFEST / BALANCED labels after scoring."""
    if not scored:
        return scored
    by_duration = min(scored, key=lambda r: r["durationMin"])
    by_safety = max(scored, key=lambda r: r["safetyScore"])

    fastest_duration = by_duration["durationMin"] or 1.0
    fastest_safety = by_safety["safetyScore"]

    best_balanced = min(
        scored,
        key=lambda r: (
            (r["durationMin"] / fastest_duration) * 0.45
            + (1.0 - (r["safetyScore"] / max(fastest_safety, 1))) * 0.55
        ),
    )

    labels: dict[str, list[str]] = {"fastest": [], "safest": [], "balanced": []}
    for route in scored:
        if route["id"] == by_duration["id"]:
            route["labels"] = sorted(set(route.get("labels", []) + ["FASTEST"]))
            labels["fastest"].append(route["id"])
        if route["id"] == by_safety["id"]:
            route["labels"] = sorted(set(route.get("labels", []) + ["SAFEST"]))
            labels["safest"].append(route["id"])
        if route["id"] == best_balanced["id"]:
            route["labels"] = sorted(set(route.get("labels", []) + ["BALANCED"]))
            labels["balanced"].append(route["id"])

    for route in scored:
        if not route.get("labels"):
            route["labels"] = ["ALTERNATIVE"]
    return scored


def navigate_url(lat: float, lng: float) -> str:
    return f"https://www.google.com/maps/dir/?api=1&destination={lat:.6f},{lng:.6f}"


def openstreetmap_url(lat: float, lng: float) -> str:
    return f"https://www.openstreetmap.org/?mlat={lat:.6f}&mlon={lng:.6f}#map=17/{lat:.6f}/{lng:.6f}"


def straight_line_distance(origin: tuple[float, float], destination: tuple[float, float]) -> float:
    return geo.haversine_km(*origin, *destination)


def offline_routing_message(provider: str) -> dict[str, Any]:
    if provider == SIMULATED:
        return {
            "mode": "simulated",
            "note": (
                "The routing engine could not be reached, so corridors below are straight-line "
                "geometric estimates and NOT real road routes. Durations assume walking speed. "
                "Treat them as indicative only."
            ),
        }
    return {"mode": "real", "note": "Real road routes from the OSRM routing engine."}