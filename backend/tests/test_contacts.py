"""Emergency contacts CRUD, ownership isolation and validation."""

from __future__ import annotations

import pytest


def test_contacts_require_authentication(client):
    assert client.get("/api/contacts").status_code == 401


def test_empty_state_is_explicit(authed):
    body = authed.get("/api/contacts").get_json()
    assert body["contacts"] == []
    assert body["count"] == 0
    assert body["activeCount"] == 0


def test_create_contact(authed):
    response = authed.post(
        "/api/contacts",
        {"name": "Sister", "phone": "+919000004001", "relationship": "Sister", "channels": ["sms", "whatsapp"]},
    )
    assert response.status_code == 201
    contact = response.get_json()["contact"]
    assert contact["name"] == "Sister"
    assert contact["channels"] == ["sms", "whatsapp"]
    assert contact["isPrimary"] is False
    assert contact["verified"] is False


def test_phone_and_name_validation(authed):
    assert authed.post("/api/contacts", {"name": "X", "phone": "abc"}).status_code == 422
    assert authed.post("/api/contacts", {"phone": "+919000004002"}).status_code == 422
    assert authed.post("/api/contacts", {"name": "X"}).status_code == 422
    assert authed.post("/api/contacts", {"name": "X" * 200, "phone": "+919000004002"}).status_code == 422
    assert authed.post("/api/contacts", {"name": "X", "phone": "123"}).status_code == 422


def test_channel_whitelist_enforced(authed):
    response = authed.post("/api/contacts", {"name": "X", "phone": "+919000004003", "channels": ["carrier-pigeon"]})
    assert response.status_code == 422
    assert response.get_json()["error"]["fields"]["channels"] == "invalid"


def test_primary_contact_is_unique_per_user(authed):
    authed.post("/api/contacts", {"name": "A", "phone": "+919000004004", "isPrimary": True})
    authed.post("/api/contacts", {"name": "B", "phone": "+919000004005", "isPrimary": True})
    contacts = authed.get("/api/contacts").get_json()["contacts"]
    assert sum(1 for c in contacts if c["isPrimary"]) == 1


def test_update_contact(authed):
    contact_id = authed.post("/api/contacts", {"name": "Old", "phone": "+919000004006"}).get_json()["contact"]["id"]
    updated = authed.patch(f"/api/contacts/{contact_id}", {"name": "New", "channels": ["call"], "active": False})
    assert updated.status_code == 200
    assert updated.get_json()["contact"]["name"] == "New"
    assert updated.get_json()["contact"]["channels"] == ["call"]
    assert updated.get_json()["contact"]["active"] is False


def test_delete_contact(authed):
    contact_id = authed.post("/api/contacts", {"name": "Temp", "phone": "+919000004007"}).get_json()["contact"]["id"]
    assert authed.delete(f"/api/contacts/{contact_id}").status_code == 200
    assert authed.get("/api/contacts").get_json()["contacts"] == []
    assert authed.delete(f"/api/contacts/{contact_id}").status_code == 404


def test_verify_contact_is_self_confirmed(authed):
    contact_id = authed.post("/api/contacts", {"name": "V", "phone": "+919000004008"}).get_json()["contact"]["id"]
    response = authed.post(f"/api/contacts/{contact_id}/verify")
    assert response.status_code == 200
    assert response.get_json()["contact"]["verified"] is True
    assert "cannot independently verify" in response.get_json()["note"]


def test_contacts_are_owner_scoped(authed, app):
    """The old GET /api/contacts returned every user's contacts."""
    from backend.tests.conftest import ApiClient

    authed.post("/api/contacts", {"name": "Mine", "phone": "+919000004009"})
    other = ApiClient(app.test_client(), app)
    other.signup(name="Other", email="other2@example.test", phone="+919000004010")
    other.post("/api/contacts", {"name": "Theirs", "phone": "+919000004011"})

    mine = authed.get("/api/contacts").get_json()["contacts"]
    theirs = other.get("/api/contacts").get_json()["contacts"]
    assert [c["name"] for c in mine] == ["Mine"]
    assert [c["name"] for c in theirs] == ["Theirs"]


def test_cannot_update_or_delete_another_users_contact(authed, app):
    from backend.tests.conftest import ApiClient

    contact_id = authed.post("/api/contacts", {"name": "Mine", "phone": "+919000004012"}).get_json()["contact"]["id"]
    other = ApiClient(app.test_client(), app)
    other.signup(name="Attacker", email="attacker2@example.test", phone="+919000004013")

    assert other.patch(f"/api/contacts/{contact_id}", {"name": "Hijacked"}).status_code == 404
    assert other.delete(f"/api/contacts/{contact_id}").status_code == 404
    assert authed.get("/api/contacts").get_json()["contacts"][0]["name"] == "Mine"


def test_contact_cannot_be_attached_to_another_user(authed, app):
    from backend.tests.conftest import ApiClient

    other = ApiClient(app.test_client(), app)
    other.signup(name="Victim", email="victim@example.test", phone="+919000004014")
    victim_id = other.user["id"]
    created = authed.post(
        "/api/contacts",
        {"name": "Injected", "phone": "+919000004015", "userId": victim_id},
    )
    assert created.status_code == 201
    # The userId in the body was ignored; the contact belongs to the caller.
    assert authed.get("/api/contacts").get_json()["contacts"][0]["id"] == created.get_json()["contact"]["id"]
    assert other.get("/api/contacts").get_json()["contacts"] == []


def test_inactive_contacts_are_not_notified(authed):
    active_id = authed.post("/api/contacts", {"name": "Active", "phone": "+919000004016", "channels": ["sms"]}).get_json()["contact"]["id"]
    authed.post("/api/contacts", {"name": "Inactive", "phone": "+919000004017", "channels": ["sms"], "active": False})
    authed.post("/api/sos/arm", {})
    result = authed.post("/api/sos/activate", {"lat": 28.6328, "lng": 77.2197, "accuracy": 9}).get_json()
    destinations = [n for n in result["incident"]["notifications"]]
    assert len(destinations) == 1


def test_signup_can_create_first_contact(api):
    api.post(
        "/api/auth/signup",
        {
            "name": "With Contact",
            "email": "withcontact@example.test",
            "phone": "+919000004018",
            "password": "Str0ngPass123",
            "emergencyContactName": "Parent",
            "emergencyContactPhone": "+919000004019",
        },
    )
    contacts = api.get("/api/contacts").get_json()["contacts"]
    assert len(contacts) == 1
    assert contacts[0]["name"] == "Parent"
    assert contacts[0]["isPrimary"] is True