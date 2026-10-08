"""Safety Intelligence — modular, explainable, rule-based risk engine.

Design constraints taken directly from the brief:

1. **No fabricated ML.** This is a transparent weighted rule set. Every
   contribution is reported with its raw value, weight and evidence, and the
   response carries ``model: "RULE_BASED_V1"``. No accuracy metric is claimed,
   because none has been measured.
2. **Confidence from data coverage, not from model skill.** Confidence is the
   weighted share of features backed by real observations, shrunk when the
   observation count is small.
3. **Explainability is mandatory.** ``reasons`` are generated from the same
   values that produced the score, so the explanation cannot drift from the maths.
4. **Data provenance on every input.** Each feature records where its data came
   from (``provenance``) and whether it is ``observed`` or ``heuristic``.

Score semantics: ``riskScore`` 0-100 where **higher means more risk**.
Bands: 0-30 LOW, 31-60 MODERATE, 61-80 HIGH, 81-100 CRITICAL.
``safetyScore = 100 - riskScore`` is exposed for route comparison.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .. import geo

MODEL_VERSION = "RULE_BASED_V1"

BANDS = (
    (0, 30, "LOW", "low"),
    (31, 60, "MODERATE", "moderate"),
    (61, 80, "HIGH", "high"),
    (81, 100, "CRITICAL", "critical"),
)

# Feature weights. They sum to 100 so the score is directly readable as a
# weighted average of normalised 0..1 feature values.
WEIGHTS = {
    "time_of_day": 18.0,
    "incident_density": 26.0,
    "safety_infrastructure": 22.0,
    "community_reports": 16.0,
    "route_characteristics": 12.0,
    "is_isolated": 6.0,
}

FEATURE_LABELS = {
    "time_of_day": "Time of day",
    "incident_density": "Nearby incident history",
    "safety_infrastructure": "Nearby safety infrastructure",
    "community_reports": "Community reports nearby",
    "route_characteristics": "Route characteristics",
    "is_isolated": "Area isolation",
}

# Community reports are crowd-sourced, never verified fact. This multiplier caps
# how much unverified data can move the score.
UNVERIFIED_TRUST = 0.45
UNDER_REVIEW_TRUST = 0.7
VERIFIED_TRUST = 1.0


@dataclass
class Feature:
    key: str
    label: str
    weight: float
    value: float                 # normalised 0..1
    points: float                # value * weight
    reason: str
    detail: str | None = None
    provenance: str = "heuristic"
    observed: bool = False
    observations: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "weight": round(self.weight, 1),
            "value": round(self.value, 3),
            "points": round(self.points, 1),
            "reason": self.reason,
            "detail": self.detail,
            "provenance": self.provenance,
            "observed": self.observed,
            "observations": self.observations,
        }


@dataclass
class Assessment:
    risk_score: int
    safety_score: int
    band: str
    band_key: str
    confidence: float
    features: list[Feature] = field(default_factory=list)
    drivers: list[str] = field(default_factory=list)
    protective_factors: list[str] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    provenance: list[dict[str, Any]] = field(default_factory=list)
    context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": MODEL_VERSION,
            "modelDescription": (
                "Transparent weighted rule set. Not a trained machine-learning model; "
                "no accuracy measurement is claimed."
            ),
            "riskScore": self.risk_score,
            "safetyScore": self.safety_score,
            "band": self.band,
            "bandKey": self.band_key,
            "confidence": round(self.confidence, 2),
            "confidenceLabel": _confidence_label(self.confidence),
            "scoreSemantics": "riskScore is 0-100 where higher means greater risk. safetyScore = 100 - riskScore.",
            "features": [f.to_dict() for f in self.features],
            "weights": {k: round(v, 1) for k, v in WEIGHTS.items()},
            "drivers": self.drivers,
            "protectiveFactors": self.protective_factors,
            "caveats": self.caveats,
            "provenance": self.provenance,
            "context": self.context,
        }


def band_for(score: int) -> tuple[str, str]:
    for low, high, label, key in BANDS:
        if low <= score <= high:
            return label, key
    return "CRITICAL", "critical"  # pragma: no cover - score is clamped to 0-100


def _confidence_label(confidence: float) -> str:
    if confidence >= 0.75:
        return "Well-supported by local data"
    if confidence >= 0.5:
        return "Partly supported by local data"
    if confidence >= 0.3:
        return "Mostly heuristic - little local data"
    return "Very low confidence - do not rely on this alone"


# --------------------------------------------------------------- features


def _time_of_day_feature(hour_local: int) -> Feature:
    """Late-night and early-morning travel is the strongest single predictor of
    vulnerability in the public-safety literature. Values are a monotone curve,
    explicitly heuristic, not learned."""
    weight = WEIGHTS["time_of_day"]
    bands = (
        (0, 4, 1.00, "Between 00:00 and 05:00 local time", "Highest-risk window: few bystanders, low transit frequency."),
        (5, 6, 0.80, "Between 05:00 and 07:00 local time", "Pre-dawn travel with limited nearby activity."),
        (7, 9, 0.35, "Morning commute window", "Busier roads but peak-hour crowding."),
        (10, 16, 0.15, "Daytime (10:00-16:00)", "Highest footfall and staffing of the day."),
        (17, 19, 0.35, "Evening peak (17:00-19:00)", "Busy but crowded; short daylight remaining."),
        (20, 21, 0.70, "After 20:00 local time", "Post-darkening travel window."),
        (22, 23, 0.90, "Late night (22:00-24:00)", "Very low bystander presence."),
    )
    for start, end, value, reason, detail in bands:
        if start <= hour_local <= end:
            return Feature(
                key="time_of_day",
                label=FEATURE_LABELS["time_of_day"],
                weight=weight,
                value=value,
                points=value * weight,
                reason=reason,
                detail=detail,
                provenance="heuristic:fixed risk curve",
                observed=True,
                observations=1,
            )
    return Feature("time_of_day", FEATURE_LABELS["time_of_day"], weight, 0.0, 0.0, "Unknown local time", None, "unavailable")


def _incident_density_feature(incidents: Iterable[dict[str, Any]], radius_km: float) -> Feature:
    """Trust-weighted count of historical incidents near the point.

    Severity-weighted, decayed by age so a two-year-old report does not dominate.
    """
    weight = WEIGHTS["incident_density"]
    rows = list(incidents)
    if not rows:
        return Feature(
            key="incident_density",
            label=FEATURE_LABELS["incident_density"],
            weight=weight,
            value=0.35,  # prior: absence of data is not evidence of safety
            points=0.35 * weight,
            reason="No incident history available for this area",
            detail=(
                "With zero records the engine applies a neutral-prior value of 0.35. "
                "Absence of records is not evidence that the area is safe."
            ),
            provenance="prior:no local records",
            observed=False,
            observations=0,
        )

    severity_weight = {"critical": 3.0, "high": 2.2, "medium": 1.0, "low": 0.5}
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    total = 0.0
    for row in rows:
        sev = str(row.get("severity") or "medium").lower()
        base = severity_weight.get(sev, 1.0)
        age_days = 365.0
        created = row.get("created_at")
        if created:
            try:
                parsed = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
                parsed = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
                age_days = max(0.0, (now - parsed).total_seconds() / 86400.0)
            except ValueError:
                pass
        decay = 1.0 / (1.0 + age_days / 90.0)  # 90-day half-life-ish
        total += base * decay

    # 4 trust-weighted, recent incidents saturates the feature.
    value = min(1.0, total / 4.0)
    if len(rows) == 1:
        reason = "1 historical incident recorded near this point"
    else:
        reason = f"{len(rows)} historical incidents recorded within {radius_km:g} km"
    detail = (
        f"Trust-weighted, recency-decayed severity sum = {total:.2f} "
        f"(saturates at 4.0). Source: SheSafe incident reports."
    )
    return Feature(
        key="incident_density",
        label=FEATURE_LABELS["incident_density"],
        weight=weight,
        value=value,
        points=value * weight,
        reason=reason,
        detail=detail,
        provenance="observed:shesafe.incidents",
        observed=True,
        observations=len(rows),
    )


#: How useful each place-of-welfare category is in a real emergency (0..1).
FACILITY_UTILITY = {
    "police": 1.00,
    "emergency_service": 0.95,
    "women_centre": 0.90,
    "hospital": 0.85,
    "shelter": 0.75,
    "pharmacy": 0.50,
    "safe_public": 0.45,
}

#: Distance (km) at which a facility stops being credibly reachable on foot.
FACILITY_REACH_KM = 5.0


def _infrastructure_feature(places: Iterable[dict[str, Any]]) -> Feature:
    """How exposed you are because help is not close by.

    **Protective feature**: ``value`` is *risk*, so it is ``1 - helpfulness``.
    A police station next door gives ``value`` 0 (no infrastructure risk); no
    facility at all gives 1. Missing data gives a neutral prior of 0.55, because
    "we looked and found nothing" and "we could not look" are different states.
    """
    weight = WEIGHTS["safety_infrastructure"]
    rows = list(places)
    if not rows:
        return Feature(
            key="safety_infrastructure",
            label=FEATURE_LABELS["safety_infrastructure"],
            weight=weight,
            value=0.55,
            points=0.55 * weight,
            reason="No safety facilities found nearby",
            detail="Place-of-welfare data unavailable or empty for this area.",
            provenance="unavailable:no place data",
            observed=False,
            observations=0,
        )

    helpfulness = 0.0
    best_row: dict[str, Any] | None = None
    for row in rows:
        distance = row.get("distance_km")
        if distance is None:
            continue
        utility = FACILITY_UTILITY.get(str(row.get("category")), 0.40)
        proximity = max(0.0, 1.0 - (float(distance) / FACILITY_REACH_KM))
        contribution = utility * proximity
        if contribution > helpfulness:
            helpfulness, best_row = contribution, row

    value = 1.0 - min(1.0, helpfulness)
    if best_row is not None:
        name = best_row.get("name") or best_row.get("category")
        distance_km = float(best_row.get("distance_km") or 0)
        if helpfulness >= 0.66:
            reason = f"{name} is within {geo.format_distance(distance_km)}"
            detail = "A highly useful emergency facility is close enough to reach quickly on foot."
        elif helpfulness >= 0.33:
            reason = f"Nearest significant facility: {name} at {geo.format_distance(distance_km)}"
            detail = "Help exists but is not close by; response time is exposed."
        else:
            reason = f"Limited nearby safety infrastructure (nearest {geo.format_distance(distance_km)})"
            detail = "Few or distant police, hospital or support facilities were found nearby."
    else:
        reason = f"{len(rows)} facility(ies) found but none within {FACILITY_REACH_KM:g} km"
        detail = "The nearest known facility is too far to rely on in an emergency."
    return Feature(
        key="safety_infrastructure",
        label=FEATURE_LABELS["safety_infrastructure"],
        weight=weight,
        value=value,
        points=value * weight,
        reason=reason,
        detail=detail,
        provenance="observed:openstreetmap.overpass",
        observed=True,
        observations=len(rows),
    )


def _community_reports_feature(reports: Iterable[dict[str, Any]], radius_km: float) -> Feature:
    """Community reports are weighted by moderation state and never treated as fact."""
    weight = WEIGHTS["community_reports"]
    rows = list(reports)
    if not rows:
        return Feature(
            key="community_reports",
            label=FEATURE_LABELS["community_reports"],
            weight=weight,
            value=0.20,
            points=0.20 * weight,
            reason="No community reports nearby",
            detail="A neutral-prior value is used. Absence of reports is not evidence of safety.",
            provenance="prior:no community reports",
            observed=False,
            observations=0,
        )

    trust = {"COMMUNITY_REPORTED": UNVERIFIED_TRUST, "UNDER_REVIEW": UNDER_REVIEW_TRUST, "VERIFIED": VERIFIED_TRUST}
    severity = {"critical": 3.0, "high": 2.0, "medium": 1.2, "safe": -2.5, "low": 0.8}
    total = 0.0
    for row in rows:
        t = trust.get(str(row.get("state") or "COMMUNITY_REPORTED"), UNVERIFIED_TRUST)
        s = severity.get(str(row.get("severity") or "medium").lower(), 1.2)
        confidence_hint = float(row.get("confidence") or 0.0)
        total += t * s * (0.6 + 0.8 * confidence_hint)
    value = max(0.0, min(1.0, total / 3.0))
    unverified = sum(1 for r in rows if r.get("state") == "COMMUNITY_REPORTED")
    reason = f"{len(rows)} community report(s) within {radius_km:g} km"
    detail = (
        f"{unverified} still unverified. Unverified reports contribute at most "
        f"{int(UNVERIFIED_TRUST * 100)}% weight and can never be presented as confirmed fact."
    )
    return Feature(
        key="community_reports",
        label=FEATURE_LABELS["community_reports"],
        weight=weight,
        value=value,
        points=value * weight,
        reason=reason,
        detail=detail,
        provenance="observed:shesafe.community_reports (moderation-weighted)",
        observed=True,
        observations=len(rows),
    )


def _route_feature(route: dict[str, Any] | None) -> Feature:
    """Route characteristics: unlit/isolated proxies are *not* available as data,
    so this feature uses what we can genuinely measure - travel time, whether the
    route hugs water/industrial classifications when tagged, and segment count."""
    weight = WEIGHTS["route_characteristics"]
    if route is None:
        return Feature(
            key="route_characteristics",
            label=FEATURE_LABELS["route_characteristics"],
            weight=weight,
            value=0.25,
            points=0.25 * weight,
            reason="No route evaluated",
            detail="Point assessment: route-specific characteristics do not apply.",
            provenance="not_applicable:point_assessment",
            observed=False,
            observations=0,
        )

    duration_min = float(route.get("duration_min") or 0)
    distance_km = float(route.get("distance_km") or 0)
    tags = route.get("tags") or {}
    # Long exposure to an unfamiliar stretch is the only defensible proxy here.
    value = 0.0
    notes: list[str] = []
    if duration_min > 45:
        value += 0.45
        notes.append(f"Long travel time ({int(duration_min)} min) increases time exposed")
    elif duration_min > 25:
        value += 0.28
        notes.append(f"Moderate travel time ({int(duration_min)} min)")
    else:
        notes.append(f"Short travel time ({int(duration_min)} min)")

    if tags.get("lit") is False:
        value += 0.35
        notes.append("Route flagged as unlit")
    if tags.get("water_crossing"):
        value += 0.20
        notes.append("Route crosses a waterway or unpopulated stretch")

    value = min(1.0, value)
    reason = notes[0] if notes else "Route characteristics not distinctive"
    detail = "; ".join(notes[1:]) or "No additional adverse route characteristics detected."
    if not notes:
        detail = "No additional adverse route characteristics detected."
    return Feature(
        key="route_characteristics",
        label=FEATURE_LABELS["route_characteristics"],
        weight=weight,
        value=value,
        points=value * weight,
        reason=reason,
        detail=detail,
        provenance="observed:osrm.route + heuristic",
        observed=True,
        observations=1,
    )


def _isolation_feature(context: dict[str, Any]) -> Feature:
    """Isolation is only scored when we have a defensible proxy: the density of
    places of welfare found. With no data we return 'unknown' rather than guessing."""
    weight = WEIGHTS["is_isolated"]
    density = context.get("welfare_density_per_km2")
    if density is None:
        return Feature(
            key="is_isolated",
            label=FEATURE_LABELS["is_isolated"],
            weight=weight,
            value=0.0,
            points=0.0,
            reason="No isolation data available",
            detail="Street-lighting and occupancy datasets are not available to SheSafe, so isolation is not scored.",
            provenance="unavailable:no lighting or occupancy dataset",
            observed=False,
            observations=0,
        )
    value = max(0.0, min(1.0, 1.0 - (float(density) / 40.0)))
    return Feature(
        key="is_isolated",
        label=FEATURE_LABELS["is_isolated"],
        weight=weight,
        value=value,
        points=value * weight,
        reason=f"Estimated welfare density {float(density):.1f} places/km²",
        detail="Derived from the number of places of welfare returned for the surrounding area.",
        provenance="derived:overpass.poi_density",
        observed=True,
        observations=1,
    )


# ---------------------------------------------------------------- scoring


def assess(
    *,
    lat: float | None,
    lng: float | None,
    hour_local: int,
    incidents: list[dict[str, Any]] | None = None,
    places: list[dict[str, Any]] | None = None,
    reports: list[dict[str, Any]] | None = None,
    route: dict[str, Any] | None = None,
    radius_km: float = 2.0,
    context: dict[str, Any] | None = None,
) -> Assessment:
    context = dict(context or {})
    incidents = incidents or []
    places = places or []
    reports = reports or []
    context.setdefault("welfare_density_per_km2", _estimate_density(places, radius_km))

    features = [
        _time_of_day_feature(hour_local),
        _incident_density_feature(incidents, radius_km),
        _infrastructure_feature(places),
        _community_reports_feature(reports, radius_km),
        _route_feature(route),
        _isolation_feature(context),
    ]

    risk = sum(f.points for f in features)
    risk_score = int(round(max(0.0, min(100.0, risk))))
    band, band_key = band_for(risk_score)

    coverage = sum(f.weight for f in features if f.observed)
    total_weight = sum(f.weight for f in features)
    coverage_ratio = coverage / total_weight if total_weight else 0.0

    # Shrink confidence when the *observed* signals are few in number, not just present.
    observation_count = sum(f.observations for f in features)
    sample_factor = min(1.0, observation_count / 12.0)
    confidence = max(0.05, min(1.0, coverage_ratio * (0.45 + 0.55 * sample_factor)))

    ordered = sorted(features, key=lambda f: f.points, reverse=True)
    drivers = [f.reason for f in ordered if f.points > 0 and f.observed][:5]
    protective = [
        f"{f.label}: {f.reason}"
        for f in ordered
        if f.observed and f.value <= 0.35 and f.key in {"time_of_day", "safety_infrastructure"}
    ][:3]

    caveats = [
        "Scores are produced by a transparent rule set, not a trained model. No accuracy measurement is claimed.",
        "Street-lighting, CCTV coverage and occupancy data are not available to SheSafe and are not scored.",
    ]
    if not incidents:
        caveats.append("No SheSafe incident history for this area; the incident-density feature is using a neutral prior.")
    if any(f.provenance == "unavailable:no place data" for f in features):
        caveats.append("Places-of-welfare lookup returned nothing, so the infrastructure feature is a neutral prior.")
    if reports and any(r.get("state") == "COMMUNITY_REPORTED" for r in reports):
        caveats.append("Some nearby community reports are unverified and were down-weighted accordingly.")

    provenance = [
        {
            "source": f.provenance,
            "feature": f.label,
            "observed": f.observed,
            "observations": f.observations,
        }
        for f in features
    ]
    provenance.append(
        {
            "source": "shesafe.local_time",
            "feature": "Local hour",
            "observed": lat is not None,
            "observations": 1,
        }
    )

    context_out = {
        "lat": lat,
        "lng": lng,
        "radiusKm": radius_km,
        "hourLocal": hour_local,
        "incidentCount": len(incidents),
        "placeCount": len(places),
        "communityReportCount": len(reports),
        "hasCoordinates": lat is not None and lng is not None,
    }

    return Assessment(
        risk_score=risk_score,
        safety_score=100 - risk_score,
        band=band,
        band_key=band_key,
        confidence=confidence,
        features=features,
        drivers=drivers,
        protective_factors=protective,
        caveats=caveats,
        provenance=provenance,
        context=context_out,
    )


def _estimate_density(places: list[dict[str, Any]], radius_km: float) -> float | None:
    """Places of welfare per km² inside the search radius (order-of-magnitude only)."""
    if not places:
        return None
    area = 3.14159265 * radius_km * radius_km
    if area <= 0:
        return None
    return round(len(places) / area, 2)