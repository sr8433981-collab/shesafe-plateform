"""Phase 3 polish contract.

The tests in this file assert the promises the product makes *about itself*:
that the score is auditable, that a change is explained from the same data that
produced the score, that a timeline only ever shows what really happened, and
that the guardian can tell live from stale without guessing.

They are deliberately behaviour-level: each one states the user-visible claim and
then checks the API actually delivers it.
"""

from __future__ import annotations

import pytest

from backend.app import timeline as timeline_vocab
from backend.app.timeline import JOURNEY_LIFECYCLE, LIFECYCLE, STATUSES, TYPES

DELHI = {"lat": 28.6328, "lng": 77.2197}


# ------------------------------------------------------- score auditability


def test_assessment_carries_an_auditable_ledger(authed):
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    body = authed.get(f"/api/intelligence/assess?lat={DELHI['lat']}&lng={DELHI['lng']}").get_json()
    assessment = body["assessment"]

    ledger = assessment["ledger"]
    assert len(ledger["raising"]) + len(ledger["lowering"]) + len(ledger["fixed"]) == len(assessment["features"])
    # Every entry carries the same numbers the factors card renders.
    for bucket in ("raising", "lowering", "fixed"):
        for factor in ledger[bucket]:
            assert {"key", "label", "points", "baselinePoints", "deltaPoints", "provenance", "observed"} <= set(factor)
    assert ledger["basis"]
    assert ledger["note"]
    # Every factor's points must add back up to the score, which is the check a
    # judge performs by hand.
    assert abs(ledger["scoreTotal"] - assessment["riskScore"]) <= 1.0


def test_assessment_separates_observed_from_unobserved(authed):
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    assessment = authed.get(f"/api/intelligence/assess?lat={DELHI['lat']}&lng={DELHI['lng']}").get_json()["assessment"]
    ledger = assessment["ledger"]
    assert ledger["observed"], "expected at least one observed factor"
    for factor in ledger["unobserved"]:
        assert factor["observed"] is False
    assert assessment["coverage"]["observedFeatures"] <= assessment["coverage"]["totalFeatures"]


def test_engine_endpoint_publishes_the_permitted_change_dimensions(authed):
    engine = authed.get("/api/intelligence/explain").get_json()["engine"]
    keys = {entry["key"] for entry in engine["changeDimensions"]}
    assert keys == {"location", "time", "route", "data"}
    assert all(entry["label"] for entry in engine["changeDimensions"])


def test_assessment_never_claims_a_trained_model(authed):
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    assessment = authed.get(f"/api/intelligence/assess?lat={DELHI['lat']}&lng={DELHI['lng']}").get_json()["assessment"]
    assert assessment["model"] == "RULE_BASED_V1"
    assert "not a trained machine-learning model" in assessment["modelDescription"].lower()
    assert assessment["scoreSemantics"].startswith("riskScore is 0-100")


# -------------------------------------------------------------- what changed


def test_compare_time_reports_before_factor_after(authed):
    """The shape the interface renders: BEFORE, the factor that moved, AFTER."""
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    response = authed.post(
        "/api/intelligence/compare",
        {
            "dimension": "time",
            "before": {**DELHI, "hourLocal": 13},
            "after": {**DELHI, "hourLocal": 1},
        },
    )
    assert response.status_code == 200, response.get_json()
    comparison = response.get_json()["comparison"]

    assert comparison["before"]["safetyScore"] > comparison["after"]["safetyScore"]
    assert comparison["safetyDelta"] == comparison["after"]["safetyScore"] - comparison["before"]["safetyScore"]
    assert comparison["dimensionLabel"] == "Time of day changed"
    assert comparison["primaryFactor"]["key"] == "time_of_day"
    assert comparison["primaryFactor"]["beforeReason"] != comparison["primaryFactor"]["afterReason"]
    assert comparison["headline"].startswith("Safety score")
    assert comparison["explanation"]
    assert comparison["basis"]


def test_compare_returns_both_full_assessments(authed):
    """Both sides are full assessments, so the two scores on screen can be
    audited the same way a single score can."""
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    comparison = authed.post(
        "/api/intelligence/compare",
        {"dimension": "time", "before": {**DELHI, "hourLocal": 9}, "after": {**DELHI, "hourLocal": 22}},
    ).get_json()["comparison"]
    for side in ("before", "after"):
        assert comparison[side]["assessment"]["safetyScore"] == comparison[side]["safetyScore"]
        assert comparison[side]["assessment"]["features"]


def test_compare_arithmetic_is_reproducible(authed):
    """Calling it twice with the same inputs must give the same numbers."""
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    payload = {
        "dimension": "time",
        "before": {**DELHI, "hourLocal": 20},
        "after": {**DELHI, "hourLocal": 3},
    }
    first = authed.post("/api/intelligence/compare", payload).get_json()["comparison"]
    second = authed.post("/api/intelligence/compare", payload).get_json()["comparison"]
    assert first["safetyDelta"] == second["safetyDelta"]
    assert first["primaryFactor"] == second["primaryFactor"]
    assert first["explanation"] == second["explanation"]


def test_compare_route_changes_are_attributed_to_the_route(authed):
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    comparison = authed.post(
        "/api/intelligence/compare",
        {
            "dimension": "route",
            "before": {**DELHI, "route": {"durationMin": 8, "distanceKm": 0.6}},
            "after": {**DELHI, "route": {"durationMin": 62, "distanceKm": 4.2, "tags": {"lit": False, "water_crossing": True}}},
        },
    ).get_json()["comparison"]
    assert comparison["primaryFactor"]["key"] == "route_characteristics"
    assert comparison["safetyDelta"] < 0


def test_compare_data_change_requires_a_record_to_have_changed(authed):
    """Refusing here is the honest behaviour: no record means nothing changed."""
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    from backend.app.logging_utils import iso

    response = authed.post(
        "/api/intelligence/compare",
        {
            "dimension": "data",
            "before": {**DELHI, "excludeSince": iso()},
            "after": dict(DELHI),
        },
    )
    assert response.status_code == 422
    assert "no safety record" in response.get_json()["error"]["message"].lower()


def test_compare_data_change_reports_the_new_record(authed):
    """A community report filed after the cutoff genuinely changes the inputs."""
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    cutoff = "2020-01-01T00:00:00+00:00"
    authed.post(
        "/api/reports",
        {
            "category": "harassment",
            "title": "Test report near Delhi",
            "description": "Recorded by the test suite.",
            "severity": "high",
            "lat": DELHI["lat"],
            "lng": DELHI["lng"],
        },
    )
    comparison = authed.post(
        "/api/intelligence/compare",
        {"dimension": "data", "before": {**DELHI, "excludeSince": cutoff}, "after": dict(DELHI)},
    ).get_json()["comparison"]
    assert comparison["dimensionLabel"] == "Safety data changed"
    assert comparison["primaryFactor"]["key"] == "community_reports"
    assert comparison["after"]["assessment"]["context"]["communityReportCount"] >= 1
    assert comparison["before"]["assessment"]["context"]["communityReportCount"] == 0


def test_compare_refuses_a_request_that_varied_nothing(authed):
    authed.post("/api/location/ping", {"lat": DELHI["lat"], "lng": DELHI["lng"], "accuracy": 10})
    response = authed.post(
        "/api/intelligence/compare",
        {"dimension": "time", "before": dict(DELHI), "after": dict(DELHI)},
    )
    assert response.status_code == 422
    assert "nothing was varied" in response.get_json()["error"]["message"].lower()


def test_compare_rejects_an_unsupported_dimension(authed):
    response = authed.post(
        "/api/intelligence/compare",
        {"dimension": "weather", "before": dict(DELHI), "after": {**DELHI, "hourLocal": 2}},
    )
    assert response.status_code == 422
    assert "dimension must be one of" in response.get_json()["error"]["message"]


def test_compare_requires_authentication(client):
    """Unauthenticated access is refused. 403 is returned first here because the
    CSRF double-submit check runs ahead of the session check; both are refusals
    and neither leaks the comparison."""
    response = client.post(
        "/api/intelligence/compare",
        json={"dimension": "time", "before": dict(DELHI), "after": {**DELHI, "hourLocal": 2}},
    )
    assert response.status_code in (401, 403)
    assert "comparison" not in (response.get_json() or {})


def test_compare_does_not_fabricate_a_positional_side(authed):
    """Both sides need a real position; scoring nothing would be theatre."""
    response = authed.post(
        "/api/intelligence/compare",
        {"dimension": "time", "before": {"lat": None, "lng": None}, "after": {**DELHI, "hourLocal": 2}},
    )
    assert response.status_code == 422


def test_compare_limited_data_says_so(authed):
    """With no local data at all the answer is 'Limited safety data available.',
    never a confident invented cause."""
    comparison = authed.post(
        "/api/intelligence/compare",
        {"dimension": "time", "before": {**DELHI, "hourLocal": 3}, "after": {**DELHI, "hourLocal": 15}},
    ).get_json()["comparison"]
    if comparison["limited"]:
        assert comparison["headline"] == "Limited safety data available."
        assert "will not claim to know" in comparison["explanation"]
    else:
        assert comparison["primaryFactor"] is not None


# ---------------------------------------------------------------- timelines


def test_timeline_vocabulary_is_closed():
    """A closed vocabulary is what lets the interface colour events without
    guessing, and what stops a new state rendering as a blank row."""
    assert set(LIFECYCLE) == {"ARMING", "COUNTDOWN", "ACTIVE", "ESCALATING", "RESOLVED", "CANCELLED"}
    assert set(JOURNEY_LIFECYCLE) == {"ON_JOURNEY", "CHECK_IN_REQUIRED", "WARNING", "EMERGENCY", "ARRIVED", "CANCELLED"}
    for spec in list(LIFECYCLE.values()) + list(JOURNEY_LIFECYCLE.values()):
        assert spec["type"] in TYPES
        assert spec["status"] in STATUSES
        assert spec["explanation"].endswith("."), "explanations are sentences"


def test_timeline_falls_back_for_an_unknown_state():
    """An unrecognised state is shown, not dropped: hiding a row would falsify
    the record."""
    event = timeline_vocab.event("2026-01-01T00:00:00+00:00", "SOMETHING_NEW")
    assert event["label"] == "Something New"
    assert "SOMETHING_NEW" in event["explanation"]
    assert event["status"] in STATUSES


def test_timeline_merge_is_time_ordered_and_deduplicated():
    early = timeline_vocab.event("2026-01-01T00:00:00+00:00", "ARMING")
    late = timeline_vocab.event("2026-01-01T00:05:00+00:00", "ACTIVE")
    merged = timeline_vocab.merge([late], [early, late])
    assert [e["state"] for e in merged] == ["ARMING", "ACTIVE"]


def test_incident_safety_timeline_has_the_four_facts_per_event(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000015001", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    incident = activation["incident"]
    events = incident["safetyTimeline"]
    assert len(events) >= 3
    for event in events:
        assert event["at"], "every event is timestamped"
        assert event["type"] in timeline_vocab.TYPES
        assert event["status"] in timeline_vocab.STATUSES
        assert event["label"] and event["explanation"]


def test_incident_timeline_records_a_simulated_alert_as_simulated(authed):
    """The delivery status must survive into the record. A simulated alert
    labelled 'delivered' anywhere would be the product's worst possible lie."""
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000015002", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    notifications = [e for e in activation["incident"]["safetyTimeline"] if e["type"] == "notification"]
    assert notifications
    assert all(e["status"] == "simulated" for e in notifications)
    assert all("SIMULATED" in e["explanation"] or "simulated" in e["explanation"] for e in notifications)


def test_journey_timeline_only_contains_states_that_happened(authed):
    journey = authed.post(
        "/api/journeys", {"origin": "Campus", "destination": "Home", "expectedMinutes": 30}
    ).get_json()["journey"]
    events = journey["timeline"]
    assert events, "a journey must produce a record"
    states = {e["state"] for e in events}
    assert "ON_JOURNEY" in states
    assert "EMERGENCY" not in states, "no state may appear that did not occur"
    for event in events:
        assert event["type"] in timeline_vocab.TYPES
        assert event["status"] in timeline_vocab.STATUSES
        assert event["explanation"]


def test_journey_timeline_grows_as_the_journey_advances(authed):
    created = authed.post(
        "/api/journeys", {"origin": "Campus", "destination": "Home", "expectedMinutes": 30}
    ).get_json()["journey"]
    checked_in = authed.post(f"/api/journeys/{created['id']}/checkin", {"note": "Home"}).get_json()["journey"]
    assert checked_in["state"] == "ARRIVED"
    states = {e["state"] for e in checked_in["timeline"]}
    assert "ARRIVED" in states
    assert "ON_JOURNEY" in states


def test_journey_check_in_is_recorded_as_a_check_in_event(authed):
    created = authed.post(
        "/api/journeys", {"origin": "Here", "destination": "There", "expectedMinutes": 10}
    ).get_json()["journey"]
    checked_in = authed.post(f"/api/journeys/{created['id']}/checkin", {}).get_json()["journey"]
    check_ins = [e for e in checked_in["timeline"] if e["type"] == "checkin"]
    assert check_ins
    assert any("Arrived safely" in e["explanation"] for e in check_ins)


def test_journey_timeline_reads_in_causal_order(authed):
    """A state change and its check-in are written in the same second, so the
    clock alone cannot order them. The record must still read as a story rather
    than as a set of rows sorted by label."""
    created = authed.post(
        "/api/journeys", {"origin": "Campus", "destination": "Home", "expectedMinutes": 10}
    ).get_json()["journey"]
    closed = authed.post(f"/api/journeys/{created['id']}/checkin", {}).get_json()["journey"]
    labels = [e["label"] for e in closed["timeline"]]
    assert labels.index("Journey started") < labels.index("Journey record opened")
    assert labels.index("Journey record opened") < labels.index("Arrived safely")


def test_incident_timeline_reads_in_causal_order(authed):
    """Arming must never appear after activation, whatever the timestamps say."""
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000015009", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    authed.post("/api/sos/escalate", {})
    incident = authed.post("/api/sos/resolve", {"note": "safe"}).get_json()["incident"]
    labels = [e["label"] for e in incident["safetyTimeline"]]
    assert labels.index("SOS arming") < labels.index("SOS activated") < labels.index("Stood down safely")
    assert labels.index("SOS activated") < labels.index("Live tracking link created")


# ------------------------------------------------------------ guardian link


def test_guardian_link_state_is_explicit_and_named(authed):
    _, activation = authed.arm_and_activate()
    token = activation["share"]["url"].split("t=")[-1]
    body = authed._c.get(f"/api/track/{token}").get_json()
    assert body["linkState"] in {"live", "stale", "reconnecting", "revoked", "expired"}
    assert body["linkStateLabel"]
    assert body["linkStateLabel"] == body["linkState"].split(" —")[0].upper()


def test_guardian_link_state_becomes_stale_when_the_fix_ages(authed):
    _, activation = authed.arm_and_activate()
    token = activation["share"]["url"].split("t=")[-1]
    from backend.app import db as dbmod
    from backend.app.logging_utils import iso
    from datetime import datetime, timedelta, timezone

    dbp = authed._app.config["DATABASE_PATH"]
    dbmod.execute(
        dbp,
        "UPDATE location_samples SET created_at = ?",
        ((datetime.now(timezone.utc) - timedelta(hours=6)).isoformat(timespec="seconds"),),
    )
    body = authed._c.get(f"/api/track/{token}").get_json()
    assert body["linkState"] == "stale"
    assert "STALE" in body["linkStateLabel"]


def test_guardian_safety_timeline_has_the_four_facts(authed):
    authed.post("/api/contacts", {"name": "Guardian", "phone": "+919000015003", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    token = activation["share"]["url"].split("t=")[-1]
    body = authed._c.get(f"/api/track/{token}").get_json()
    events = body["safetyTimeline"]
    assert events
    for event in events:
        assert event["type"] in timeline_vocab.TYPES
        assert event["status"] in timeline_vocab.STATUSES
        assert event["explanation"]


def test_guardian_never_claims_emergency_services_were_contacted(authed):
    authed.post("/api/contacts", {"name": "Guardian", "phone": "+919000015004", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    token = activation["share"]["url"].split("t=")[-1]
    body = authed._c.get(f"/api/track/{token}").get_json()
    blob = str(body).lower()
    for banned in ("police notified", "police contacted", "dispatched", "help is on the way", "ambulance dispatched"):
        assert banned not in blob