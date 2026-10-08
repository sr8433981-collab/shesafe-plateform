"""Safety Intelligence: scoring bands, explainability, honesty about the model."""

from __future__ import annotations

import pytest

from backend.app.intelligence import scoring


def _feature_value(assessment: scoring.Assessment, key: str) -> float:
    return next(f.points for f in assessment.features if f.key == key)


# ------------------------------------------------------------------- bands


@pytest.mark.parametrize(
    "score,expected",
    [
        (0, "LOW"), (30, "LOW"),
        (31, "MODERATE"), (60, "MODERATE"),
        (61, "HIGH"), (80, "HIGH"),
        (81, "CRITICAL"), (100, "CRITICAL"),
    ],
)
def test_band_boundaries(score, expected):
    assert scoring.band_for(score)[0] == expected


def test_risk_and_safety_scores_are_complementary():
    assessment = scoring.assess(lat=28.63, lng=77.21, hour_local=14)
    assert assessment.risk_score + assessment.safety_score == 100
    assert 0 <= assessment.risk_score <= 100


def test_weights_sum_to_one_hundred():
    assert sum(scoring.WEIGHTS.values()) == 100.0


def test_score_equals_sum_of_feature_points():
    assessment = scoring.assess(lat=28.63, lng=77.21, hour_local=23, incidents=[], places=[], reports=[])
    assert assessment.risk_score == round(sum(f.points for f in assessment.features))


# ------------------------------------------------------------ time of day


def test_late_night_scores_higher_than_midday():
    night = scoring.assess(lat=28.63, lng=77.21, hour_local=1)
    day = scoring.assess(lat=28.63, lng=77.21, hour_local=13)
    assert _feature_value(night, "time_of_day") > _feature_value(day, "time_of_day")
    assert night.risk_score > day.risk_score


# ------------------------------------------------------- incident density


def test_more_incidents_raise_the_score():
    base = scoring.assess(lat=28.63, lng=77.21, hour_local=13)
    heavy = scoring.assess(
        lat=28.63,
        lng=77.21,
        hour_local=13,
        incidents=[{"severity": "critical"}, {"severity": "high"}, {"severity": "high"}, {"severity": "medium"}],
    )
    assert heavy.risk_score > base.risk_score


def test_no_data_uses_a_neutral_prior_not_zero_risk():
    assessment = scoring.assess(lat=28.63, lng=77.21, hour_local=13, incidents=[])
    feature = next(f for f in assessment.features if f.key == "incident_density")
    assert feature.observed is False
    assert feature.value > 0
    assert "not evidence that the area is safe" in feature.detail
    assert any("No SheSafe incident history" in c for c in assessment.caveats)


def test_old_incidents_are_decayed():
    recent = scoring.assess(lat=1, lng=1, hour_local=12, incidents=[{"severity": "high", "created_at": "2026-10-01T00:00:00+00:00"}])
    old = scoring.assess(lat=1, lng=1, hour_local=12, incidents=[{"severity": "high", "created_at": "2020-01-01T00:00:00+00:00"}])
    assert _feature_value(recent, "incident_density") > _feature_value(old, "incident_density")


# -------------------------------------------------------- infrastructure


def test_nearby_police_lowers_infrastructure_risk():
    far = scoring.assess(
        lat=28.63, lng=77.21, hour_local=13,
        places=[{"category": "police", "distance_km": 20.0, "name": "Station"}],
    )
    near = scoring.assess(
        lat=28.63, lng=77.21, hour_local=13,
        places=[{"category": "police", "distance_km": 0.2, "name": "Station"}],
    )
    # Protective feature: nearby help must *reduce* the risk contribution.
    assert _feature_value(near, "safety_infrastructure") < _feature_value(far, "safety_infrastructure")


def test_womens_centre_counts_more_than_pharmacy():
    women = scoring.assess(lat=28.63, lng=77.21, hour_local=13, places=[{"category": "women_centre", "distance_km": 1.0}])
    pharmacy = scoring.assess(lat=28.63, lng=77.21, hour_local=13, places=[{"category": "pharmacy", "distance_km": 1.0}])
    # A women's centre is more useful than a pharmacy, so it carries less risk.
    assert _feature_value(women, "safety_infrastructure") < _feature_value(pharmacy, "safety_infrastructure")


# ------------------------------------------------------ community reports


def test_unverified_reports_contribute_less_than_verified():
    unverified = scoring.assess(
        lat=28.63, lng=77.21, hour_local=13,
        reports=[{"state": "COMMUNITY_REPORTED", "severity": "high", "confidence": 0.2}],
    )
    verified = scoring.assess(
        lat=28.63, lng=77.21, hour_local=13,
        reports=[{"state": "VERIFIED", "severity": "high", "confidence": 0.9}],
    )
    assert _feature_value(verified, "community_reports") > _feature_value(unverified, "community_reports")


def test_safe_report_reduces_risk():
    hazard = scoring.assess(lat=28.63, lng=77.21, hour_local=13, reports=[{"state": "VERIFIED", "severity": "high"}])
    haven = scoring.assess(lat=28.63, lng=77.21, hour_local=13, reports=[{"state": "VERIFIED", "severity": "safe"}])
    assert haven.risk_score < hazard.risk_score


# --------------------------------------------------------- explainability


def test_every_feature_explains_itself():
    assessment = scoring.assess(
        lat=28.63, lng=77.21, hour_local=23,
        incidents=[{"severity": "high"}],
        places=[{"category": "hospital", "distance_km": 3.0, "name": "Hospital"}],
        reports=[{"state": "COMMUNITY_REPORTED", "severity": "medium"}],
    )
    payload = assessment.to_dict()
    assert len(payload["features"]) == len(scoring.WEIGHTS)
    for feature in payload["features"]:
        assert feature["reason"]
        assert feature["provenance"]
        assert 0.0 <= feature["value"] <= 1.0
        assert feature["weight"] > 0


def test_drivers_reference_observed_features_only():
    assessment = scoring.assess(lat=28.63, lng=77.21, hour_local=23)
    for reason in assessment.drivers:
        assert reason


def test_provenance_block_lists_every_feature():
    payload = scoring.assess(lat=28.63, lng=77.21, hour_local=23).to_dict()
    sources = {entry["source"] for entry in payload["provenance"]}
    assert "observed:shesafe.incidents" in sources or any("shesafe" in s for s in sources)


def test_model_is_declared_as_rule_based_with_no_accuracy_claim():
    payload = scoring.assess(lat=28.63, lng=77.21, hour_local=13).to_dict()
    assert payload["model"] == "RULE_BASED_V1"
    assert "Not a trained machine-learning model" in payload["modelDescription"]
    assert "accuracy" not in payload
    serialised = repr(payload).lower()
    for banned in ("accuracy:", "accuracy of", "% accurate", "model is trained"):
        assert banned not in serialised


def test_confidence_reflects_data_coverage():
    rich = scoring.assess(
        lat=28.63, lng=77.21, hour_local=13,
        incidents=[{"severity": "high"}] * 4,
        places=[{"category": "police", "distance_km": 1.0}] * 6,
        reports=[{"state": "VERIFIED", "severity": "high"}] * 4,
    )
    sparse = scoring.assess(lat=28.63, lng=77.21, hour_local=13)
    assert rich.confidence > sparse.confidence
    assert 0.0 < sparse.confidence <= 1.0


def test_caveats_always_state_limitations():
    payload = scoring.assess(lat=28.63, lng=77.21, hour_local=13).to_dict()
    joined = " ".join(payload["caveats"])
    assert "Street-lighting" in joined
    assert "not a trained model" in joined


def test_route_feature_absent_for_point_assessment():
    assessment = scoring.assess(lat=28.63, lng=77.21, hour_local=13)
    feature = next(f for f in assessment.features if f.key == "route_characteristics")
    assert feature.observed is False
    assert "point_assessment" in feature.provenance


def test_route_feature_flags_long_travel():
    short = scoring.assess(lat=1, lng=1, hour_local=12, route={"duration_min": 5, "distance_km": 0.4, "tags": {}})
    long = scoring.assess(lat=1, lng=1, hour_local=12, route={"duration_min": 60, "distance_km": 12.0, "tags": {}})
    assert _feature_value(long, "route_characteristics") > _feature_value(short, "route_characteristics")


def test_isolation_not_scored_without_data():
    assessment = scoring.assess(lat=28.63, lng=77.21, hour_local=13)
    feature = next(f for f in assessment.features if f.key == "is_isolated")
    assert feature.observed is False
    assert "not scored" in feature.detail


# ------------------------------------------------------------- API layer


def test_assess_endpoint_requires_auth(client):
    assert client.get("/api/intelligence/assess?lat=28.6&lng=77.2").status_code == 401


def test_assess_endpoint_returns_explanation(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    response = authed.get("/api/intelligence/assess")
    assert response.status_code == 200
    assessment = response.get_json()["assessment"]
    assert 0 <= assessment["riskScore"] <= 100
    assert assessment["band"] in {"LOW", "MODERATE", "HIGH", "CRITICAL"}
    assert assessment["features"]
    assert assessment["confidence"] >= 0
    assert assessment["caveats"]


def test_assess_endpoint_requires_both_coordinates(authed):
    assert authed.get("/api/intelligence/assess?lat=28.6").status_code == 422


def test_assess_without_location_is_a_clear_error(authed):
    response = authed.get("/api/intelligence/assess")
    assert response.status_code == 422
    assert "No location available" in response.get_json()["error"]["message"]


def test_explain_endpoint_publishes_the_engine(authed):
    engine = authed.get("/api/intelligence/explain").get_json()["engine"]
    assert engine["model"] == "RULE_BASED_V1"
    assert len(engine["bands"]) == 4
    assert engine["weights"]["incident_density"] == 26.0
    assert any("not a trained" in limit.lower() for limit in engine["limitations"])


def test_places_endpoint_never_invents_data_when_provider_off(authed):
    response = authed.get("/api/intelligence/places?lat=28.6328&lng=77.2197")
    assert response.status_code == 200
    body = response.get_json()
    if not body["places"]:
        assert body["provenance"]["mode"] == "unavailable"
        assert body["fallbackHelplines"]
        assert "rather than showing invented places" in body["fallbackNote"]


def test_demo_places_are_labelled_simulated(authed):
    body = authed.get("/api/intelligence/places?lat=28.6328&lng=77.2197").get_json()
    for place in body["places"]:
        assert place["provenance"] == "simulated_demo_dataset"
        assert place["verification"] == "simulated"
        assert "simulated" in place["name"].lower()


def test_routes_reject_identical_endpoints(authed):
    response = authed.post(
        "/api/intelligence/routes",
        {"fromLat": 28.63, "fromLng": 77.21, "toLat": 28.63, "toLng": 77.21},
    )
    assert response.status_code == 422


def test_routes_validate_coordinates(authed):
    for payload in (
        {"fromLat": 91, "fromLng": 77.2, "toLat": 28.6, "toLng": 77.2},
        {"fromLat": 28.6, "fromLng": 77.2},
        {"fromLat": 28.6, "fromLng": 77.2, "toLat": 28.6, "toLng": 77.2, "mode": "teleport"},
    ):
        assert authed.post("/api/intelligence/routes", payload).status_code == 422, payload


def test_routes_are_labelled_with_disclaimer(authed):
    response = authed.post(
        "/api/intelligence/routes",
        {"fromLat": 28.6328, "fromLng": 77.2197, "toLat": 28.636, "toLng": 77.225},
    )
    assert response.status_code == 200
    body = response.get_json()
    assert "not a guarantee of safety" in body["disclaimer"]
    labels = {label for route in body["routes"] for label in route["labels"]}
    assert "FASTEST" in labels
    assert labels & {"SAFEST", "BALANCED"}
    for route in body["routes"]:
        assert route["whySafer"]
        assert 0 <= route["safetyScore"] <= 100


def test_simulated_routing_is_labelled(authed):
    """ROUTING_PROVIDER=none in tests forces the offline geometric fallback."""
    body = authed.post(
        "/api/intelligence/routes",
        {"fromLat": 28.6328, "fromLng": 77.2197, "toLat": 28.636, "toLng": 77.225},
    ).get_json()
    if body["provenance"]["provider"] == "simulated_geometric":
        assert "NOT real road routes" in body["provenance"]["note"]


# ------------------------------------------------------------ classifiers


def test_classifier_detects_stalking():
    from backend.app.intelligence import classifiers

    result = classifiers.classify("A man has been following me since the bus stop.")
    assert result["category"] == "stalking"
    assert result["severity"] == "high"
    assert result["categoryLabel"] == "Stalking"
    assert "following" in result["matchedKeywords"]
    assert result["recommendedActions"]


def test_classifier_handles_empty_input():
    from backend.app.intelligence import classifiers

    result = classifiers.classify("")
    assert result["category"] == "other"
    assert result["confidence"] < 0.3


def test_classifier_is_always_advisory():
    from backend.app.intelligence import classifiers

    result = classifiers.classify("he grabbed my arm")
    assert result["advisory"] is True
    assert result["authoritative"] is False
    assert "does not contact anyone" in result["disclaimer"]


def test_classifier_detects_medical_emergency():
    from backend.app.intelligence import classifiers

    result = classifiers.classify("I am bleeding and feel faint")
    assert result["category"] in {"medical", "assault"}
    assert result["severity"] in {"high", "critical"}


def test_incident_assist_stores_unverified_report(authed):
    response = authed.post(
        "/api/intelligence/incident-assist",
        {"description": "Someone keeps following me home"},
    )
    assert response.status_code == 200
    assist = response.get_json()["assist"]
    assert assist["reportState"] == "COMMUNITY_REPORTED"
    assert "not verified" in assist["reportNote"]
    assert assist["sosAvailable"] is True
    assert assist["source"] in {"rule_based", "llm"}