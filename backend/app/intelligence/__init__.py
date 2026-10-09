"""Safety Intelligence service layer.

Provides the three composite capabilities used by the API:

* ``assess_point``  -> risk score for the user's current position
* ``plan_routes``   -> candidate routes, each safety-scored and labelled
* ``describe_places`` -> nearby safety facilities with real provenance

Everything degrades honestly: if an external provider is unreachable the response
says ``mode: "unavailable"`` or ``"simulated"`` rather than inventing data.
"""

from __future__ import annotations

import json
from datetime import timezone
from typing import Any

from .. import db, geo, repo, timeline
from . import classifiers, places as places_mod, routing, scoring


def _incident_features(
    db_path,
    lat: float | None,
    lng: float | None,
    radius_km: float,
    *,
    user_id: str | None = None,
    exclude_since: str | None = None,
) -> list[dict[str, Any]]:
    """Historical incidents within radius, used by the incident-density feature.

    Scoped to ``user_id`` when one is supplied. The query used to read every
    incident in the table, which let any signed-in account grid-probe arbitrary
    coordinates and read back another user's emergency locations as an
    ``incidentCount``. Only the requesting user's own records are used, which is
    also what "SheSafe has no third-party incident database" actually means.

    ``exclude_since`` exists for the "safety data changed" comparison: scoring
    the same place from the records that existed *before* a given moment. The
    earlier side is recomputed from the same rows with the newer ones removed, so
    it is a real second evaluation rather than a remembered number.
    """
    if lat is None or lng is None:
        return []
    s, w, n, e = geo.bbox(lat, lng, radius_km)
    sql = """
        SELECT i.id AS id,
               i.outcome AS outcome,
               i.created_at AS created_at,
               il.lat AS lat, il.lng AS lng
        FROM incidents i
        JOIN incident_locations il ON il.incident_id = i.id
        WHERE il.lat BETWEEN ? AND ? AND il.lng BETWEEN ? AND ?
    """
    params: list[Any] = [s, n, w, e]
    if user_id:
        sql += " AND i.user_id = ?"
        params.append(user_id)
    rows = db.query(db_path, sql, tuple(params))
    cutoff = _cutoff(exclude_since)
    results: list[dict[str, Any]] = []
    for row in db.rows_to_dicts(rows):
        if cutoff and str(row["created_at"] or "") >= cutoff:
            continue
        distance = geo.haversine_km(lat, lng, row["lat"], row["lng"])
        if distance > radius_km:
            continue
        severity = "high" if row["outcome"] in {"CANCELLED", "RESOLVED_ESCALATED", None} else "medium"
        results.append({"id": row["id"], "severity": severity, "created_at": row["created_at"], "distance_km": distance})
    return results


def _cutoff(exclude_since: str | None) -> str | None:
    """Normalise an ISO timestamp to a comparable UTC string, or None."""
    if not exclude_since:
        return None
    parsed = timeline.parse(exclude_since)
    if parsed is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")


def _community_features(
    db_path,
    lat: float | None,
    lng: float | None,
    radius_km: float,
    *,
    exclude_since: str | None = None,
) -> list[dict[str, Any]]:
    rows = repo.list_reports(db_path, near=(lat, lng), radius_km=radius_km, limit=40) if lat is not None and lng is not None else repo.list_reports(db_path, limit=25)
    cutoff = _cutoff(exclude_since)
    if cutoff:
        rows = [row for row in rows if str(row.get("created_at") or "") < cutoff]
    return rows


def _places_for_scoring(db_path, lat, lng, config, radius_km: float) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if lat is None or lng is None:
        return [], {"provider": "none", "mode": "unavailable", "note": "No coordinates supplied."}
    if config.get("DEMO_MODE") and config.get("PLACES_PROVIDER") in {"none", "unavailable"}:
        payload = places_mod.demo_places(lat, lng)
        return payload["places"], payload["provenance"]
    payload = places_mod.fetch_places(
        db_path=db_path, lat=lat, lng=lng, config=config, max_radius_km=max(radius_km * 2, 8.0)
    )
    for place in payload["places"]:
        place["distance_km"] = place.get("distanceKm")
    return payload["places"], payload.get("provenance", {})


def assess_point(
    *,
    db_path,
    config,
    lat: float | None,
    lng: float | None,
    radius_km: float = 2.0,
    route: dict[str, Any] | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    hour_local = geo.local_hour()
    incidents = _incident_features(db_path, lat, lng, radius_km, user_id=user_id)
    if user_id:
        own = repo.list_incidents(db_path, user_id, limit=25)
        known_ids = {i["id"] for i in incidents}
        incidents.extend(
            {"id": i["id"], "severity": "high", "created_at": i["created_at"], "distance_km": 0.0}
            for i in own
            if i["id"] not in known_ids
        )
    near_places, provenance = _places_for_scoring(db_path, lat, lng, config, radius_km)
    reports = _community_features(db_path, lat, lng, radius_km)

    assessment = scoring.assess(
        lat=lat,
        lng=lng,
        hour_local=hour_local,
        incidents=incidents,
        places=near_places,
        reports=reports,
        route=route,
        radius_km=radius_km,
    )
    payload = assessment.to_dict()
    payload["placesProvenance"] = provenance
    if lat is not None and lng is not None:
        payload["context"]["reverseGeocode"] = None
    return payload


def compare_point(
    *,
    db_path,
    config,
    before: dict[str, Any],
    after: dict[str, Any],
    dimension: str,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Score two points with the same engine and subtract.

    This is the whole of "what changed": no second model, no heuristic narrative.
    ``before`` and ``after`` each name a position (and optionally an hour and a
    route), the engine scores each one exactly as it would score a live request,
    and :func:`scoring.compare` subtracts the results.

    Only one dimension is allowed to vary per request, so the label in the UI
    always matches the arithmetic. A request that changes nothing is refused.
    """
    hour_local = geo.local_hour()
    radius_km = float(before.get("radiusKm") or after.get("radiusKm") or 2.0)

    def evaluate(spec: dict[str, Any]) -> scoring.Assessment:
        lat, lng = spec.get("lat"), spec.get("lng")
        # Only the "data" dimension removes records. For every other dimension the
        # two sides must read exactly the same rows, so that any movement in the
        # score is attributable to the one thing the caller said changed.
        exclude_since = spec.get("excludeSince") if dimension == "data" else None
        incidents = _incident_features(
            db_path, lat, lng, radius_km, user_id=user_id, exclude_since=exclude_since
        )
        if user_id:
            own = repo.list_incidents(db_path, user_id, limit=25)
            known_ids = {i["id"] for i in incidents}
            incidents.extend(
                {"id": i["id"], "severity": "high", "created_at": i["created_at"], "distance_km": 0.0}
                for i in own
                if i["id"] not in known_ids
                and (not exclude_since or str(i.get("created_at") or "") < _cutoff(exclude_since))
            )
        near_places, _ = _places_for_scoring(db_path, lat, lng, config, radius_km)
        return scoring.assess(
            lat=lat,
            lng=lng,
            hour_local=int(spec.get("hourLocal") if spec.get("hourLocal") is not None else hour_local),
            incidents=incidents,
            places=near_places,
            reports=_community_features(db_path, lat, lng, radius_km, exclude_since=exclude_since),
            route=spec.get("route"),
            radius_km=radius_km,
        )

    before_assessment = evaluate(before)
    after_assessment = evaluate(after)

    # The request must actually have varied something. Otherwise the comparison
    # would report "unchanged" for a reason the caller got wrong.
    if dimension == "data":
        # A data comparison is meaningful only when there was a record to remove.
        if before_assessment.context["incidentCount"] == after_assessment.context["incidentCount"] and \
           before_assessment.context["communityReportCount"] == after_assessment.context["communityReportCount"]:
            raise ValueError(
                "No safety record was created after the supplied cutoff, so there is no data change to show. "
                "Raise an SOS or file a community report first, then compare."
            )
    elif _same_inputs(before, after, radius_km):
        raise ValueError(
            "Nothing was varied between the two scores. Change the position, the hour, the route "
            "or the underlying safety data — not more than one at a time."
        )

    change = scoring.compare(before_assessment, after_assessment, dimension=dimension)
    payload = change.to_dict()
    payload["before"]["assessment"] = before_assessment.to_dict()
    payload["after"]["assessment"] = after_assessment.to_dict()
    payload["requested"] = {"before": before, "after": after}
    return payload


def _same_inputs(before: dict[str, Any], after: dict[str, Any], radius_km: float) -> bool:
    def norm(spec):
        return (
            spec.get("lat"),
            spec.get("lng"),
            spec.get("hourLocal"),
            spec.get("radiusKm") or radius_km,
            json.dumps(spec.get("route"), sort_keys=True) if spec.get("route") else None,
        )

    return norm(before) == norm(after)


def plan_routes(
    *,
    db_path,
    config,
    origin: tuple[float, float],
    destination: tuple[float, float],
    mode: str = "walk",
    user_id: str | None = None,
) -> dict[str, Any]:
    """Fetch candidate routes and safety-score each one."""
    hour_local = geo.local_hour()
    provider_note: dict[str, Any]
    try:
        result = routing.fetch_osrm_routes(
            origin=origin,
            destination=destination,
            timeout=float(config.get("EXTERNAL_HTTP_TIMEOUT", 8.0)),
        )
        provider_note = routing.offline_routing_message("osrm")
    except routing.RoutingUnavailable as exc:
        result = routing.simulated_routes(origin, destination)
        provider_note = routing.offline_routing_message(result["provider"])
        provider_note["reason"] = str(exc)

    scored: list[dict[str, Any]] = []
    for index, route in enumerate(result["routes"]):
        geometry = [tuple(point) for point in route["geometry"]]
        route["tags"] = routing.tag_route(geometry)
        # Evaluate risk at several points along the corridor, not just the midpoint.
        samples = routing.sample_route_points(geometry, count=9)

        # Places of welfare are fetched ONCE for the whole corridor. Fetching per
        # sample point would multiply an external round-trip by nine and make the
        # screen unusable when the provider is slow. The corridor is short
        # relative to the 5 km proximity radius, so this is a fair approximation.
        mid_lat, mid_lng = routing.midpoint(geometry)
        corridor_places, corridor_provenance = _places_for_scoring(db_path, mid_lat, mid_lng, config, 2.5)
        sample_assessments = []
        for slat, slng in samples:
            shifted_places = [
                {**place, "distance_km": geo.haversine_km(slat, slng, place["lat"], place["lng"])}
                for place in corridor_places
            ]
            sample_assessments.append(
                scoring.assess(
                    lat=slat,
                    lng=slng,
                    hour_local=hour_local,
                    incidents=_incident_features(db_path, slat, slng, 1.0, user_id=user_id),
                    places=shifted_places,
                    reports=_community_features(db_path, slat, slng, 1.5),
                    route=route,
                    radius_km=1.5,
                )
            )
        # Corridor risk = mean of samples, so a single bad stretch is visible
        # without one unlucky sample dominating the whole route.
        mean_risk = sum(a.risk_score for a in sample_assessments) / len(sample_assessments)
        worst = max(sample_assessments, key=lambda a: a.risk_score)
        best = min(sample_assessments, key=lambda a: a.risk_score)
        confidence = sum(a.confidence for a in sample_assessments) / len(sample_assessments)

        distance_km = route["distanceKm"]
        speed = {"walk": geo.WALK_KMH, "cycle": geo.CYCLE_KMH, "drive": geo.CAR_KMH}.get(mode, geo.WALK_KMH)
        if result["provider"] != routing.SIMULATED:
            duration_min = round(route["durationMin"], 1)
        else:
            duration_min = round(distance_km / speed * 60, 1)

        scored.append(
            {
                "id": f"route_{index}_{route['providerId']}",
                "providerId": route["providerId"],
                "label": route.get("label") or ("Primary route" if index == 0 else f"Alternative {index}"),
                "geometry": route["geometry"],
                "distanceKm": distance_km,
                "durationMin": duration_min,
                "safetyScore": int(round(100 - mean_risk)),
                "riskScore": int(round(mean_risk)),
                "band": scoring.band_for(int(round(mean_risk)))[0],
                "confidence": round(confidence, 2),
                "tags": route["tags"],
                "worstPoint": {"lat": worst.context["lat"], "lng": worst.context["lng"], "riskScore": worst.risk_score},
                "bestPoint": {"lat": best.context["lat"], "lng": best.context["lng"], "riskScore": best.risk_score},
                "drivers": worst.drivers[:3],
                "whySafer": _why_text(worst, best, index, result["provider"]),
                "placesProvenance": corridor_provenance,
                "labels": [],
            }
        )

    scored = routing.label_routes(scored)
    return {
        "routes": scored,
        "provenance": {
            "provider": result["provider"],
            **provider_note,
            "candidatesEvaluated": len(scored),
            "safetyEngine": scoring.MODEL_VERSION,
        },
        "mode": mode,
    }


def _why_text(worst: scoring.Assessment, best: scoring.Assessment, index: int, provider: str) -> list[str]:
    lines: list[str] = []
    if index == 0:
        lines.append("Shortest/fastest road route returned by the routing engine.")
    else:
        lines.append("Alternative corridor returned by the routing engine.")
    if provider == routing.SIMULATED:
        lines.append("SIMULATED corridor: geometric estimate, not a real road route.")
    for feature in sorted(worst.features, key=lambda f: f.points, reverse=True)[:2]:
        if feature.observed and feature.points > 1.0:
            lines.append(f"{feature.label}: {feature.reason}")
    for feature in best.features:
        # ``safety_infrastructure.value`` is RISK, i.e. 1 - helpfulness: a low
        # value means help is nearby. Claiming the route "passes closer to" help
        # requires a LOW value. The comparison used to be ``> 0.55``, which fired
        # exactly when the nearest facility was far away.
        if feature.key == "safety_infrastructure" and feature.observed and feature.value <= 0.55:
            lines.append("Passes closer to police, hospital or support facilities.")
            break
    return lines[:4]


def describe_places(
    *,
    db_path,
    config,
    lat: float,
    lng: float,
    categories: list[str] | None = None,
    radius_km: float = 10.0,
) -> dict[str, Any]:
    if config.get("DEMO_MODE") and config.get("PLACES_PROVIDER") in {"none", "unavailable"}:
        return places_mod.demo_places(lat, lng)
    payload = places_mod.fetch_places(
        db_path=db_path, lat=lat, lng=lng, config=config, categories=categories, max_radius_km=radius_km
    )
    if not payload["places"] and config.get("DEMO_MODE"):
        # Demo Mode exists so a presentation never dead-ends on a dead network.
        # The synthetic set is labelled `simulated_demo_dataset` on every record.
        fallback = places_mod.demo_places(lat, lng)
        fallback["provenance"] = {
            **fallback["provenance"],
            "liveLookupFailed": True,
            "liveLookupNote": "The live places lookup did not respond, so DEMO MODE substituted synthetic data.",
        }
        return fallback

    if not payload["places"]:
        # Never invent a facility. Fall back to the one thing we can state with
        # certainty: the publicly published national helplines.
        from ..api.meta import OFFICIAL_HELPLINES

        payload["fallbackHelplines"] = OFFICIAL_HELPLINES
        payload["fallbackNote"] = (
            "No nearby facilities could be loaded. Rather than showing invented places, "
            "here are the official national helplines and a link to a live map search."
        )
        payload["mapSearchUrl"] = (
            f"https://www.openstreetmap.org/search?query=hospital%20near%20"
            f"{lat:.5f}%2C{lng:.5f}"
        )
    return payload


def incident_intelligence(*, db_path, config, text: str | None, incident: dict[str, Any] | None = None) -> dict[str, Any]:
    """Classification + summary + actions, AI-optional."""
    baseline = classifiers.classify(text)
    used = "rule_based"
    ai_note = "AI provider not configured; using the transparent rule-based classifier."
    try:
        from . import llm

        ai_result = llm.classify_incident(text or "", config)
    except Exception:  # AI must never break the feature
        ai_result = None
    if ai_result:
        baseline = ai_result
        used = "llm"
        ai_note = "AI classification returned; still advisory and unverified."

    payload = dict(baseline)
    payload["fallbackClassifier"] = classifiers.classify(text)
    payload["source"] = used
    payload["aiNote"] = ai_note

    if incident:
        payload["summary"] = classifiers.summarise(incident)
    if text:
        stored = repo.create_report(
            db_path,
            {
                "user_id": incident.get("user_id") if incident else None,
                "category": payload["category"],
                "title": (text or "")[:120],
                "description": text,
                "severity": payload["severity"],
            },
        )
        payload["reportId"] = stored["id"]
        payload["reportState"] = stored["state"]
        payload["reportNote"] = (
            "Stored as COMMUNITY_REPORTED. It is not verified and will not be shown as fact."
        )
    return payload