"""SOS lifecycle, duplicate prevention, validation and honest notification reporting."""

from __future__ import annotations


def test_lifecycle_document_is_public(authed):
    response = authed.get("/api/sos/lifecycle")
    assert response.status_code == 200
    states = response.get_json()["lifecycle"]["states"]
    assert states == ["IDLE", "ARMING", "COUNTDOWN", "ACTIVE", "ESCALATING", "RESOLVED", "CANCELLED"]


def test_arm_creates_countdown_state_and_reference(authed):
    response = authed.post("/api/sos/arm", {})
    assert response.status_code == 201
    incident = response.get_json()["incident"]
    assert incident["state"] == "COUNTDOWN"
    assert incident["reference"].startswith("SS-")
    assert response.get_json()["cancelWindowSeconds"] >= 3


def test_duplicate_sos_is_suppressed(authed):
    first = authed.post("/api/sos/arm", {})
    assert first.status_code == 201
    second = authed.post("/api/sos/arm", {})
    assert second.status_code == 409
    assert second.get_json()["error"]["code"] == "duplicate_suppressed"
    assert second.get_json()["error"]["reference"] == first.get_json()["incident"]["reference"]
    # Exactly one open incident.
    assert len(authed.get("/api/sos/incidents").get_json()["incidents"]) == 1


def test_duplicate_activate_does_not_double_alert(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009001", "channels": ["sms"]})
    authed.post("/api/sos/arm", {})
    first = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    assert first.status_code == 201
    incident_id = first.get_json()["incident"]["id"]
    # A retried activate is accepted but reports zero new deliveries.
    second = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 10})
    assert second.status_code == 200
    assert second.get_json()["duplicateSuppressed"] is True
    detail = authed.get(f"/api/sos/incidents/{incident_id}").get_json()["incident"]
    assert len(detail["notifications"]) == 1  # the retry alerted nobody again


def test_full_lifecycle_arm_activate_escalate_resolve(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009002", "channels": ["sms"]})
    authed.post("/api/sos/arm", {})
    activated = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9})
    incident_id = activated.get_json()["incident"]["id"]
    assert activated.get_json()["incident"]["state"] == "ACTIVE"

    escalated = authed.post("/api/sos/escalate", {})
    assert escalated.get_json()["incident"]["state"] == "ESCALATING"

    resolved = authed.post("/api/sos/resolve", {"note": "Reached a safe place"})
    incident = resolved.get_json()["incident"]
    assert incident["state"] == "RESOLVED"
    assert incident["outcome"] == "RESOLVED_SAFE"
    assert incident["resolutionNote"] == "Reached a safe place"
    assert incident["resolvedAt"]

    timeline = [entry["state"] for entry in incident["timeline"]]
    assert timeline == ["ARMING", "COUNTDOWN", "ACTIVE", "ESCALATING", "RESOLVED"]


def test_cancel_before_activation_sends_no_contact_message(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009003", "channels": ["sms"]})
    arm = authed.post("/api/sos/arm", {}).get_json()["incident"]
    cancelled = authed.post("/api/sos/cancel", {"reason": "False alarm"})
    incident = cancelled.get_json()["incident"]
    assert incident["state"] == "CANCELLED"
    assert cancelled.get_json()["contactsWereNotified"] is False
    assert incident["notifications"] == []


def test_cancel_after_activation_records_that_contacts_were_told(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009004", "channels": ["sms"]})
    authed.post("/api/sos/arm", {})
    authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9})
    cancelled = authed.post("/api/sos/cancel", {"reason": "Stood down"})
    assert cancelled.get_json()["contactsWereNotified"] is True
    assert cancelled.get_json()["incident"]["outcome"] == "CANCELLED"
    # A stand-down message was attempted as well.
    assert len(cancelled.get_json()["incident"]["notifications"]) == 2


def test_activate_without_open_incident_conflicts(authed):
    response = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197})
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "no_open_incident"


def test_activate_rejects_invalid_coordinates(authed):
    authed.post("/api/sos/arm", {})
    for payload in (
        {"lat": 91, "lng": 77.2},
        {"lat": 28.6, "lng": 181},
        {"lat": "not-a-number", "lng": 77.2},
        {"lat": 28.6, "lng": 77.2, "accuracy": 99999},
    ):
        response = authed.post("/api/sos/activate", payload)
        assert response.status_code == 422, (payload, response.get_json())


def test_invalid_location_leaves_incident_activatable(authed):
    """A rejected fix must not leave the incident half-activated."""
    authed.post("/api/sos/arm", {})
    assert authed.post("/api/sos/activate", {"lat": 500, "lng": 500}).status_code == 422
    assert authed.get("/api/sos/active").get_json()["incident"]["state"] == "COUNTDOWN"
    ok = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 8})
    assert ok.status_code == 201


def test_notification_status_is_simulated_without_credentials(authed):
    authed.post("/api/contacts", {"name": "Sister", "phone": "+919000009005", "channels": ["sms", "call"]})
    authed.post("/api/sos/arm", {})
    result = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9}).get_json()
    summary = result["notificationSummary"]

    # sms -> simulated (no provider), call -> unavailable (server cannot place a call)
    assert summary["simulated"] == 1
    assert summary["unavailable"] == 1
    assert summary["delivered"] == 0
    assert summary["policeNotified"] is False
    assert "did not contact police" in summary["statement"]
    assert result["disclaimer"].startswith("SheSafe has not contacted any emergency service")


def test_activate_returns_no_claim_of_police_dispatch(authed):
    authed.post("/api/sos/arm", {})
    body = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9}).get_json()
    serialised = repr(body).lower()
    for banned in ("pcr unit", "police mobilised", "police mobilized", "police control room", "dispatched to police", "112 / pcr"):
        assert banned not in serialised, banned
    assert body["nextActions"]["call112"] == "tel:112"


def test_escalate_is_idempotent(authed):
    authed.post("/api/sos/arm", {})
    authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9})
    first = authed.post("/api/sos/escalate", {})
    assert first.get_json()["incident"]["state"] == "ESCALATING"
    second = authed.post("/api/sos/escalate", {})
    assert second.get_json()["alreadyEscalating"] is True


def test_trigger_source_validation(authed):
    bad = authed.post("/api/sos/arm", {"triggerSource": "telepathy"})
    assert bad.status_code == 422


def test_incident_is_owner_scoped(authed, app):
    from backend.tests.conftest import ApiClient

    arm = authed.post("/api/sos/arm", {}).get_json()["incident"]
    other = ApiClient(app.test_client(), app)
    other.signup(name="Nosy", email="nosy@example.test", phone="+919000008888")
    assert other.get(f"/api/sos/incidents/{arm['id']}").status_code == 404
    assert other.get("/api/sos/active").get_json()["incident"] is None


def test_audit_trail_records_sos_transitions(authed, app):
    from backend.app import db

    arm = authed.post("/api/sos/arm", {}).get_json()["incident"]
    authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9})
    actions = {
        row["action"]
        for row in db.query(
            app.config["DATABASE_PATH"],
            "SELECT action FROM audit_log WHERE target_id = ?",
            (arm["id"],),
        )
    }
    assert {"sos.arm", "sos.activate"} <= actions


def test_sos_works_with_no_contacts_configured(authed):
    authed.post("/api/sos/arm", {})
    result = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9}).get_json()
    assert result["notificationSummary"]["delivered"] == 0
    assert "No emergency contacts are configured" in result["notificationSummary"]["statement"]


def test_voice_trigger_source_is_recorded(authed):
    arm = authed.post("/api/sos/arm", {"triggerSource": "voice"}).get_json()["incident"]
    assert arm["triggerSource"] == "voice"