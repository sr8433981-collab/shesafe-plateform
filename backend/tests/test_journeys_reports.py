"""Journey Guard escalation and community report moderation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from backend.app import db as dbmod
from backend.app.logging_utils import iso


def _backdate_journey(app, journey_id: str, minutes: int) -> None:
    due = iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))
    dbmod.execute(app.config["DATABASE_PATH"], "UPDATE journeys SET due_at = ? WHERE id = ?", (due, journey_id))


# -------------------------------------------------------------- journeys


def test_journeys_require_auth(client):
    assert client.get("/api/journeys").status_code == 401
    assert client.post("/api/journeys", json={"origin": "A", "destination": "B", "expectedMinutes": 5}).status_code in (401, 403)


def test_create_journey(authed):
    response = authed.post("/api/journeys", {"origin": "Campus", "destination": "Home", "expectedMinutes": 20})
    assert response.status_code == 201
    journey = response.get_json()["journey"]
    assert journey["state"] == "ON_JOURNEY"
    assert journey["origin"] == "Campus"
    assert journey["expectedMinutes"] == 20


def test_only_one_active_journey(authed):
    authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5})
    second = authed.post("/api/journeys", {"origin": "C", "destination": "D", "expectedMinutes": 5})
    assert second.status_code == 409


def test_journey_validation(authed):
    assert authed.post("/api/journeys", {"origin": "A", "destination": "B"}).status_code == 422
    assert authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 0}).status_code == 422
    assert authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 99999}).status_code == 422
    assert authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5, "contactId": "cnt_nope"}).status_code == 404


def test_journey_states_escalate_on_read(authed, app):
    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    _backdate_journey(app, journey["id"], 1)
    active = authed.get("/api/journeys/active").get_json()
    assert active["journey"]["state"] == "CHECK_IN_REQUIRED"
    assert active["requiresAction"] is True

    _backdate_journey(app, journey["id"], 30)  # past the grace period
    warned = authed.get("/api/journeys/active").get_json()
    assert warned["journey"]["state"] == "WARNING"


def test_journey_checkin_closes_it(authed, app):
    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    _backdate_journey(app, journey["id"], 30)
    response = authed.post(f"/api/journeys/{journey['id']}/checkin", {"note": "Home safe"})
    assert response.status_code == 200
    assert response.get_json()["journey"]["state"] == "ARRIVED"
    assert response.get_json()["journey"]["checkedInAt"]
    assert authed.get("/api/journeys/active").get_json()["journey"] is None


def test_journey_escalation_creates_a_real_sos_incident(authed, app):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009111", "channels": ["sms"]})
    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    _backdate_journey(app, journey["id"], 30)
    response = authed.post(f"/api/journeys/{journey['id']}/escalate")
    assert response.status_code == 200
    assert response.get_json()["journey"]["state"] == "EMERGENCY"

    active = authed.get("/api/sos/active").get_json()["incident"]
    assert active["state"] == "ACTIVE"
    assert active["triggerSource"] == "journey"
    assert "Call 112" in response.get_json()["note"]


def test_journey_escalate_twice_conflicts(authed, app):
    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    authed.post(f"/api/journeys/{journey['id']}/escalate")
    second = authed.post(f"/api/journeys/{journey['id']}/escalate")
    assert second.status_code == 409


def test_journey_cancel(authed):
    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    response = authed.post(f"/api/journeys/{journey['id']}/cancel")
    assert response.get_json()["journey"]["state"] == "CANCELLED"


def test_journey_monitoring_limitation_is_disclosed(authed):
    body = authed.get("/api/journeys").get_json()
    assert "cannot" in body["disclaimer"].lower()
    assert "page open" in body["disclaimer"].lower()


def test_journeys_are_owner_scoped(authed, app):
    from backend.tests.conftest import ApiClient

    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    other = ApiClient(app.test_client(), app)
    other.signup(name="Nosy", email="nosy3@example.test", phone="+919000009122")
    assert other.post(f"/api/journeys/{journey['id']}/cancel").status_code == 404
    assert other.get("/api/journeys/active").get_json()["journey"] is None


# --------------------------------------------------------------- check-ins


def test_checkin(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    response = authed.post("/api/checkins", {})
    assert response.status_code == 201
    assert "safe" in response.get_json()["checkIn"]["message"]
    assert len(authed.get("/api/checkins").get_json()["checkIns"]) == 1


def test_checkin_closes_active_journey(authed):
    journey = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5}).get_json()["journey"]
    authed.post("/api/checkins", {})
    assert authed.get("/api/journeys/active").get_json()["journey"] is None


# --------------------------------------------------------------- reports


def test_report_starts_unverified(authed):
    response = authed.post(
        "/api/reports",
        {"category": "unsafe_area", "title": "Underpass lights out", "description": "No lighting after 21:00", "severity": "moderate"},
    )
    assert response.status_code == 201
    report = response.get_json()["report"]
    assert report["state"] == "COMMUNITY_REPORTED"
    assert report["stateLabel"] == "Community reported"
    assert report["confidence"] == 0.0
    assert "not verified" in response.get_json()["notice"]


def test_report_validation(authed):
    assert authed.post("/api/reports", {"title": "No category"}).status_code == 201  # category defaults
    assert authed.post("/api/reports", {"category": "wat"}).status_code == 422
    assert authed.post("/api/reports", {"title": "x", "evidenceUrl": "javascript:alert(1)"}).status_code == 422
    assert authed.post("/api/reports", {}).status_code == 422


def test_report_rate_limit_modERATION_guard(authed):
    authed.post("/api/reports", {"category": "unsafe_area", "title": "First"})
    second = authed.post("/api/reports", {"category": "unsafe_area", "title": "Second"})
    assert second.status_code == 409
    assert second.get_json()["error"]["code"] == "rate_limited_report"


def test_anonymous_report_hides_the_author(authed):
    response = authed.post(
        "/api/reports",
        {"category": "theft", "title": "Bag stolen", "anonymous": True, "lat": 28.63, "lng": 77.21},
    )
    report = response.get_json()["report"]
    assert report["anonymous"] is True
    from backend.app import repo

    stored = repo.get_report(authed._app.config["DATABASE_PATH"], report["id"])
    assert stored["user_id"] is None


def test_moderation_requires_evidence_for_verification(authed):
    report = authed.post("/api/reports", {"category": "theft", "title": "Snatched"}).get_json()["report"]
    # Cannot jump straight to VERIFIED without confidence and a note.
    assert authed.post(f"/api/reports/{report['id']}/moderate", {"state": "VERIFIED"}).status_code == 422
    ok = authed.post(
        f"/api/reports/{report['id']}/moderate",
        {"state": "UNDER_REVIEW", "note": "Cross-checking with two witnesses"},
    )
    assert ok.status_code == 200
    assert ok.get_json()["report"]["state"] == "UNDER_REVIEW"
    assert "would require a moderator role" in ok.get_json()["note"]


def test_moderation_state_machine(authed):
    report = authed.post("/api/reports", {"category": "harassment", "title": "Catcalls"}).get_json()["report"]
    authed.post(f"/api/reports/{report['id']}/moderate", {"state": "UNDER_REVIEW"})
    verified = authed.post(
        f"/api/reports/{report['id']}/moderate",
        {"state": "VERIFIED", "confidence": 0.8, "note": "Two independent reports + CCTV review"},
    )
    assert verified.get_json()["report"]["state"] == "VERIFIED"
    assert verified.get_json()["report"]["confidence"] == 0.8
    dismissed = authed.post(f"/api/reports/{report['id']}/moderate", {"state": "DISMISSED", "note": "Unsubstantiated"})
    assert dismissed.get_json()["report"]["state"] == "DISMISSED"


def test_moderation_rejects_unknown_state(authed):
    report = authed.post("/api/reports", {"category": "theft", "title": "X"}).get_json()["report"]
    assert authed.post(f"/api/reports/{report['id']}/moderate", {"state": "TRUTH"}).status_code == 422


def test_helpful_vote_is_idempotent_per_user(authed, app):
    from backend.tests.conftest import ApiClient

    report = authed.post("/api/reports", {"category": "harassment", "title": "Notices"}).get_json()["report"]
    first = authed.post(f"/api/reports/{report['id']}/helpful").get_json()
    assert first["helpfulCount"] == 1 and first["counted"] is True
    second = authed.post(f"/api/reports/{report['id']}/helpful").get_json()
    assert second["helpfulCount"] == 1 and second["counted"] is False

    other = ApiClient(app.test_client(), app)
    other.signup(name="Voter", email="voter@example.test", phone="+919000009133")
    assert other.post(f"/api/reports/{report['id']}/helpful").get_json()["helpfulCount"] == 2


def test_dismissed_reports_leave_the_public_feed(authed):
    report = authed.post("/api/reports", {"category": "theft", "title": "Bad rumour"}).get_json()["report"]
    authed.post(f"/api/reports/{report['id']}/moderate", {"state": "DISMISSED", "note": "False"})
    ids = [r["id"] for r in authed.get("/api/reports").get_json()["reports"]]
    assert report["id"] not in ids


def test_reports_are_scoped_to_visible_states(authed):
    kept = authed.post("/api/reports", {"category": "theft", "title": "Visible"}).get_json()["report"]
    authed.post(f"/api/reports/{kept['id']}/moderate", {"state": "UNDER_REVIEW"})
    ids = [r["id"] for r in authed.get("/api/reports").get_json()["reports"]]
    assert kept["id"] in ids


def test_report_feed_includes_state_legend(authed):
    legend = authed.get("/api/reports").get_json()["stateLegend"]
    assert legend["COMMUNITY_REPORTED"].startswith("Reported by a user")
    assert legend["VERIFIED"].startswith("Corroborated")


def test_nearby_reports_sorted_by_distance(authed):
    authed.post("/api/reports", {"category": "unsafe_area", "title": "Close", "lat": 28.6330, "lng": 77.2200})
    authed.post("/api/reports", {"category": "unsafe_area", "title": "Far", "lat": 28.6800, "lng": 77.2600})
    reports = authed.get("/api/reports?lat=28.6328&lng=77.2197&radiusKm=10").get_json()["reports"]
    distances = [r["distanceKm"] for r in reports]
    assert distances == sorted(distances)