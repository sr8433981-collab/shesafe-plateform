"""Phase 2 production-gap coverage.

Everything added in the Phase 2 pass that is a *promise* rather than a screen:

* contact ownership verification (self-confirmed vs provider-confirmed),
* moderator RBAC and the demo-only escape hatch,
* retention, cleanup and the stale-emergency policy,
* data export and account deletion,
* the additive scoring fields the "Why this score?" panel reads.

Each test asserts the behaviour *and* the honesty of the response, because an
endpoint that returns a wrong claim is a failure here even when the data is right.
"""

from __future__ import annotations

import pytest

from backend.app import db
from backend.app import repo
from backend.app.logging_utils import audit


# -------------------------------------------------------- contact lifecycle


def test_contact_can_be_edited_paused_and_reprimaried(authed):
    a = authed.post("/api/contacts", {"name": "Meera", "phone": "+919000010001", "channels": ["sms"]}).get_json()["contact"]
    b = authed.post("/api/contacts", {"name": "Kavya", "phone": "+919000010002", "channels": ["sms", "whatsapp"]}).get_json()["contact"]

    # channels
    patched = authed.patch(f"/api/contacts/{b['id']}", {"channels": ["whatsapp"]}).get_json()["contact"]
    assert patched["channels"] == ["whatsapp"]

    # pause
    paused = authed.patch(f"/api/contacts/{b['id']}", {"active": False}).get_json()["contact"]
    assert paused["active"] is False

    # primary is unique per account
    authed.patch(f"/api/contacts/{a['id']}", {"isPrimary": True})
    contacts = authed.get("/api/contacts").get_json()["contacts"]
    primaries = [c for c in contacts if c["isPrimary"]]
    assert len(primaries) == 1 and primaries[0]["id"] == a["id"]


def test_paused_contacts_are_not_alerted(authed):
    authed.post("/api/contacts", {"name": "Quiet", "phone": "+919000010010", "channels": ["sms"], "active": False})
    authed.post("/api/contacts", {"name": "Loud", "phone": "+919000010011", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    summary = activation["notificationSummary"]
    attempted = sum(summary[key] for key in ("delivered", "simulated", "failed", "unavailable", "skipped"))
    assert attempted == 1, "a paused contact must not produce an alert attempt"


# --------------------------------------------------------- contact verification


def test_self_confirmation_is_labelled_as_such(authed):
    contact = authed.post("/api/contacts", {"name": "Priya", "phone": "+919000010100", "channels": ["sms"]}).get_json()["contact"]
    assert contact["verified"] is False and contact["verifiedBy"] is None

    response = authed.post(f"/api/contacts/{contact['id']}/verify")
    body = response.get_json()
    assert body["contact"]["verified"] is True
    assert body["contact"]["verifiedBy"] == "user"
    # The wording must never imply SheSafe checked the number itself.
    assert "cannot independently verify" in body["note"]
    assert "Self-confirmed" in body["note"]


def test_verification_request_is_simulated_without_a_provider(authed):
    contact = authed.post("/api/contacts", {"name": "Anita", "phone": "+919000010200", "channels": ["sms"]}).get_json()["contact"]
    body = authed.post(f"/api/contacts/{contact['id']}/verification").get_json()
    verification = body["verification"]

    assert verification["mode"] == "simulated"
    assert verification["code"] is not None, "a simulated code must be returned so the flow is demonstrable"
    assert "SIMULATED" in verification["statement"]
    assert "no messaging provider is configured" in verification["statement"]
    assert body["contact"]["verificationPending"] is True


def test_verification_requires_the_read_back_code(authed):
    contact = authed.post("/api/contacts", {"name": "Bina", "phone": "+919000010300", "channels": ["sms"]}).get_json()["contact"]
    code = authed.post(f"/api/contacts/{contact['id']}/verification").get_json()["verification"]["code"]

    wrong = authed.post(f"/api/contacts/{contact['id']}/verification/confirm", {"code": "000000" if code != "000000" else "111111"})
    assert wrong.status_code == 422
    assert wrong.get_json()["error"]["code"] == "code_mismatch"

    still_unverified = authed.get("/api/contacts").get_json()["contacts"][0]
    assert still_unverified["verified"] is False
    assert still_unverified["verificationPending"] is True

    right = authed.post(f"/api/contacts/{contact['id']}/verification/confirm", {"code": code}).get_json()
    assert right["contact"]["verified"] is True
    assert right["contact"]["verifiedBy"] == "provider"
    assert right["contact"]["verificationPending"] is False
    assert "provider-verified" in right["note"]


def test_verification_code_is_hashed_not_stored(authed, app):
    contact = authed.post("/api/contacts", {"name": "Chitra", "phone": "+919000010400", "channels": ["sms"]}).get_json()["contact"]
    code = authed.post(f"/api/contacts/{contact['id']}/verification").get_json()["verification"]["code"]
    authed.post(f"/api/contacts/{contact['id']}/verification/confirm", {"code": code})

    stored = repo.get_contact(app.config["DATABASE_PATH"], authed.user["id"], contact["id"])
    assert stored["verification_code_hash"] is None, "the code must be destroyed once used"
    assert code not in str(stored), "the raw code must never be stored"


def test_verification_attempts_are_bounded(authed, app):
    app.config["CONTACT_VERIFICATION_MAX_ATTEMPTS"] = 3
    contact = authed.post("/api/contacts", {"name": "Divya", "phone": "+919000010500", "channels": ["sms"]}).get_json()["contact"]
    authed.post(f"/api/contacts/{contact['id']}/verification")

    for _ in range(3):
        authed.post(f"/api/contacts/{contact['id']}/verification/confirm", {"code": "999999"})

    blocked = authed.post(f"/api/contacts/{contact['id']}/verification/confirm", {"code": "999999"})
    assert blocked.status_code == 422
    assert blocked.get_json()["error"]["code"] == "too_many_attempts"


def test_confirming_without_a_pending_request_is_refused(authed):
    contact = authed.post("/api/contacts", {"name": "Esha", "phone": "+919000010600", "channels": ["sms"]}).get_json()["contact"]
    response = authed.post(f"/api/contacts/{contact['id']}/verification/confirm", {"code": "123456"})
    assert response.status_code == 422
    assert response.get_json()["error"]["code"] == "no_verification_pending"


def test_verification_is_owner_scoped(authed):
    from backend.tests.conftest import ApiClient

    contact = authed.post("/api/contacts", {"name": "Mine", "phone": "+919000010700", "channels": ["sms"]}).get_json()["contact"]
    other = ApiClient(authed._app.test_client(), authed._app)
    other.signup(name="Other User", email="other@example.test", phone="+919000010701")
    assert other.post(f"/api/contacts/{contact['id']}/verification").status_code == 404
    assert other.post(f"/api/contacts/{contact['id']}/verify").status_code == 404


# --------------------------------------------------------------- moderation


def test_moderation_requires_the_moderator_role_outside_demo(authed, app):
    from backend.tests.conftest import ApiClient

    report = authed.post("/api/reports", {"category": "harassment", "title": "Catcalls"}).get_json()["report"]

    app.config["DEMO_MODE"] = False
    denied = authed.post(f"/api/reports/{report['id']}/moderate", {"state": "UNDER_REVIEW", "note": "mine"})
    assert denied.status_code == 403
    assert denied.get_json()["error"]["code"] == "moderator_required"

    # Grant the role out of band, exactly as an operator would, then re-auth so
    # the session is resolved again from the (now updated) user row.
    repo.set_user_role(app.config["DATABASE_PATH"], authed.user["id"], "moderator")
    authed.post("/api/auth/logout")
    assert authed.reauthenticate().status_code == 200

    allowed = authed.post(f"/api/reports/{report['id']}/moderate", {"state": "UNDER_REVIEW", "note": "reviewing"})
    assert allowed.status_code == 200
    assert allowed.get_json()["permissionModel"] == "moderator_role"
    assert "Demo Mode" not in allowed.get_json()["note"]


def test_production_closes_moderation_even_when_demo_is_on(authed, app):
    report = authed.post("/api/reports", {"category": "theft", "title": "Bag"}).get_json()["report"]
    app.config["ENV"] = "production"
    app.config["MODERATION_OPEN_TO_ALL_USERS"] = True
    response = authed.post(f"/api/reports/{report['id']}/moderate", {"state": "UNDER_REVIEW", "note": "x"})
    assert response.status_code == 403


def test_verification_requires_a_written_reason(authed):
    report = authed.post("/api/reports", {"category": "assault", "title": "Needs review"}).get_json()["report"]
    no_note = authed.post(f"/api/reports/{report['id']}/moderate", {"state": "VERIFIED", "confidence": 0.9})
    assert no_note.status_code == 422
    assert "note" in str(no_note.get_json()["error"]["fields"])


# ---------------------------------------------------------------- retention


def test_retention_report_is_generated_from_the_server(authed):
    body = authed.get("/api/privacy/retention").get_json()
    assert "counts" in body and "policy" in body
    assert {c["id"] for c in body["categories"]} == {"identity", "contacts", "location", "audit", "incident"}
    assert any("hash" in note for note in body["notes"])


def test_cleanup_removes_expired_tokens_and_old_samples(authed, app):
    from backend.app import validation

    dbp = app.config["DATABASE_PATH"]
    authed.post("/api/contacts", {"name": "Trail", "phone": "+919000010800", "channels": ["sms"]})
    authed.post("/api/location/share/start", {"ttlSeconds": 60})
    authed.post("/api/location/ping", {"lat": 28.63, "lng": 77.21, "accuracy": 10})

    # Age both rows past their windows.
    db.execute(dbp, "UPDATE share_tokens SET expires_at = ?", (validation.future_iso(-60),))
    db.execute(dbp, "UPDATE location_samples SET created_at = '2000-01-01T00:00:00+00:00'")

    result = authed.post("/api/privacy/cleanup").get_json()["cleaned"]
    assert result["expiredShareTokens"] >= 1
    assert result["oldLocationSamples"] >= 1

    assert repo.list_share_tokens(dbp, authed.user["id"]) == []
    assert repo.latest_location(dbp, authed.user["id"]) is None


def test_cleanup_never_touches_incident_trails(authed, app):
    dbp = app.config["DATABASE_PATH"]
    authed.arm_and_activate()
    db.execute(dbp, "UPDATE location_samples SET created_at = '2000-01-01T00:00:00+00:00'")

    authed.post("/api/privacy/cleanup")
    remaining = repo.incident_trail(dbp, repo.find_active_incident(dbp, authed.user["id"])["id"])
    assert remaining, "an incident trail is part of the incident record and must survive cleanup"


def test_abandoned_incidents_are_closed_by_the_retention_policy(authed, app):
    dbp = app.config["DATABASE_PATH"]
    authed.arm_and_activate()
    db.execute(dbp, "UPDATE incidents SET activated_at = '2000-01-01T00:00:00+00:00', created_at = '2000-01-01T00:00:00+00:00'")

    closed = repo.purge_stale_emergency_state(dbp, max_open_hours=1)
    assert closed == 1
    incident = repo.get_incident(dbp, authed.user["id"], repo.list_incidents(dbp, authed.user["id"], 5)[0]["id"])
    assert incident["state"] == "CANCELLED"
    assert incident["resolution_note"] == "Closed automatically by the retention policy."

    states = [e["to_state"] for e in repo.list_incident_events(dbp, incident["id"])]
    assert "CANCELLED" in states, "the closure must be in the audit trail, not silent"


def test_audit_log_is_trimmed_not_grown(authed, app):
    dbp = app.config["DATABASE_PATH"]
    db.execute(dbp, "UPDATE audit_log SET created_at = '2000-01-01T00:00:00+00:00'")
    before = repo.retention_report(dbp, {})["counts"]["auditRows"]
    removed = repo.trim_audit_log(dbp, 1)
    assert removed == before
    assert repo.retention_report(dbp, {})["counts"]["auditRows"] == 0


# ---------------------------------------------------------- export & delete


def test_export_contains_the_accounts_own_records(authed):
    authed.post("/api/contacts", {"name": "Export Me", "phone": "+919000010900", "channels": ["sms"]})
    _, activation = authed.arm_and_activate()
    reference = activation["incident"]["reference"]

    body = authed.post("/api/privacy/export").get_json()["export"]
    assert body["account"]["name"] == authed.user["name"]
    assert any(c["name"] == "Export Me" for c in body["contacts"])
    assert any(i["reference"] == reference for i in body["incidents"])
    assert body["incidents"][0]["location"]["lat"] == pytest.approx(28.6328)
    assert "does not contact emergency services" in body["disclaimer"]


def test_export_is_owner_scoped(authed):
    from backend.tests.conftest import ApiClient

    authed.arm_and_activate()
    other = ApiClient(authed._app.test_client(), authed._app)
    other.signup(name="Nosy Neighbour", email="nosy@example.test", phone="+919000010901")
    body = other.post("/api/privacy/export").get_json()["export"]
    assert body["incidents"] == []
    assert body["contacts"] == []


def test_account_deletion_requires_a_typed_confirmation(authed):
    response = authed.delete("/api/account", {})
    assert response.status_code == 422
    assert "confirm" in str(response.get_json()["error"]["fields"])


def test_account_deletion_revokes_the_session_immediately(authed, app):
    dbp = app.config["DATABASE_PATH"]
    user_id = authed.user["id"]
    authed.post("/api/contacts", {"name": "Gone", "phone": "+919000011000", "channels": ["sms"]})
    authed.arm_and_activate()

    body = authed.delete("/api/account", {"confirm": "DELETE"}).get_json()
    assert body["deleted"] is True and body["sessionRevoked"] is True

    # The cookie still carries the id, but the row no longer resolves.
    assert repo.get_user(dbp, user_id) is None
    assert authed.get("/api/contacts").status_code == 401

    # Identifiers are gone.
    row = repo.get_user(dbp, user_id, include_deleted=True)
    assert row["name"] == "Deleted account"
    assert row["email"] is None and row["phone"] is None
    assert repo.list_contacts(dbp, user_id) == []
    assert repo.user_row_counts(dbp, user_id)["location_samples"] == 0

    # The incident record survives, but nothing in it identifies a person.
    incidents = repo.list_incidents(dbp, user_id, 5)
    assert len(incidents) == 1, "the safety record is kept rather than silently rewritten"
    assert db.query_one(dbp, "SELECT COUNT(*) AS c FROM incidents")["c"] == 1
    assert db.query_one(dbp, "SELECT COUNT(*) AS c FROM incident_locations")["c"] == 0, "coordinates are removed"
    assert db.query_one(dbp, "SELECT COUNT(*) AS c FROM audit_log WHERE actor_id = ?", (user_id,))["c"] == 0
    assert all(
        row[0] in (None, "Deleted account")
        for row in db.query(dbp, "SELECT actor_label FROM audit_log WHERE actor_label IS NOT NULL")
    )


def test_deleted_account_cannot_sign_in_again(authed):
    authed.delete("/api/account", {"confirm": "DELETE"})
    identifier = authed.credentials["identifier"]
    from backend.tests.conftest import ApiClient

    fresh = ApiClient(authed._app.test_client(), authed._app)
    assert fresh.login(identifier, authed.credentials["password"]).status_code == 401


def test_privacy_endpoints_require_authentication(client, app):
    # A CSRF-valid but anonymous request must be rejected as unauthenticated,
    # not as a bad token: these endpoints must never answer for a stranger.
    from backend.tests.conftest import ApiClient

    anonymous = ApiClient(client, app)
    assert anonymous.get("/api/privacy/retention").status_code == 401
    assert anonymous.post("/api/privacy/export").status_code == 401
    assert anonymous.post("/api/privacy/cleanup").status_code == 401
    assert anonymous.delete("/api/account").status_code == 401
    assert anonymous.get("/api/meta/audit").status_code == 401


# ------------------------------------------------------ guardian console data


def test_guardian_payload_is_derived_not_invented(authed):
    contact = authed.post("/api/contacts", {"name": "Guardian", "phone": "+919000011100", "channels": ["sms"]}).get_json()["contact"]
    _, activation = authed.arm_and_activate()
    url = activation["share"]["url"]
    token = url.split("t=")[-1]

    body = authed._c.get(f"/api/track/{token}").get_json()
    assert body["ok"] is True
    first, last = authed.user["name"].split()[0], authed.user["name"].split()[-1]
    assert body["subject"]["displayName"] == f"{first} {'*' * max(2, len(last) - 1)}"
    assert body["subject"]["phone"].startswith("***")
    assert body["location"]["lat"] == pytest.approx(28.6328)
    assert body["incident"]["reference"] == activation["incident"]["reference"]
    assert body["incident"]["elapsedMinutes"] is None
    assert body["delivery"]["attempted"] >= 1
    assert body["delivery"]["simulated"] >= 1
    assert body["delivery"]["delivered"] == 0

    steps = [entry["step"] for entry in body["timeline"]]
    assert steps[0].startswith("SOS ACTIVATED")
    assert any("CONTACTS NOTIFIED" in step for step in steps)
    assert "LOCATION SHARING ACTIVE" in steps
    assert steps[-1] == "LATEST UPDATE"
    # The guardian payload must never imply that help was dispatched.
    assert "Call 112" in body["disclaimer"]
    blob = str(body).lower()
    for banned in ("police notified", "dispatched", "help is on the way", "police dispatched"):
        assert banned not in blob, f"guardian payload must not claim {banned!r}"
    assert contact["id"]


def test_guardian_payload_reports_journey_state(authed):
    authed.post("/api/journeys", {"origin": "Campus", "destination": "Home", "expectedMinutes": 30})
    _, activation = authed.arm_and_activate()

    body = authed._c.get(f"/api/track/{activation['share']['url'].split('t=')[-1]}").get_json()
    assert body["journey"]["state"] in {"ON_JOURNEY", "CHECK_IN_REQUIRED", "WARNING"}
    assert body["journey"]["destination"] == "Home"
    assert body["journey"]["origin"] == "Campus"


def test_journey_accepts_a_trusted_contact(authed):
    contact = authed.post("/api/contacts", {"name": "Watchful", "phone": "+919000011200", "channels": ["sms"]}).get_json()["contact"]
    journey = authed.post("/api/journeys", {"origin": "Here", "destination": "There", "expectedMinutes": 20, "contactId": contact["id"]}).get_json()
    assert journey["journey"]["contactId"] == contact["id"]


def test_journey_rejects_a_contact_that_is_not_mine(authed):
    from backend.tests.conftest import ApiClient

    # A genuinely separate browser, so the second session cannot reuse the first
    # one's cookie jar and silently become the same account.
    other = ApiClient(authed._app.test_client(), authed._app)
    other.signup(name="Foreign Contact", email="fc@example.test", phone="+919000011300")
    foreign = other.post("/api/contacts", {"name": "Not Mine", "phone": "+919000011301", "channels": ["sms"]}).get_json()["contact"]

    response = authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 5, "contactId": foreign["id"]})
    assert response.status_code == 404, "a contact from another account must not be attachable"


# ------------------------------------------------------- scoring disclosure


def test_assessment_exposes_signed_contributions_and_coverage(authed):
    authed.post("/api/location/ping", {"lat": 28.6328, "lng": 77.2197, "accuracy": 12})
    assessment = authed.get("/api/intelligence/assess").get_json()["assessment"]

    assert assessment["coverage"]["totalFeatures"] == len(assessment["features"])
    assert assessment["coverage"]["label"] in {"GOOD", "THIN", "POOR"}
    assert "real observation" in assessment["coverage"]["note"] or "neutral prior" in assessment["coverage"]["note"]
    assert assessment["plainSummary"], "the plain-language explanation is mandatory"

    # A feature with a documented neutral prior must report both the baseline and
    # the movement away from it; one without a prior must report neither rather
    # than inventing a sign.
    for feature in assessment["features"]:
        assert ("baselinePoints" in feature) and ("deltaPoints" in feature)
        if feature["baselinePoints"] is None:
            assert feature["deltaPoints"] is None
        else:
            assert feature["baselinePoints"] == pytest.approx(
                assessment["neutralPriors"][feature["key"]] * feature["weight"], rel=0.01
            )
            assert feature["deltaPoints"] == pytest.approx(feature["points"] - feature["baselinePoints"], abs=0.11)


def test_risk_score_is_unchanged_by_the_disclosure_fields():
    """The signed deltas are a display concern; the score must not move."""
    from backend.app.intelligence import scoring
    base = scoring.assess(lat=28.63, lng=77.21, hour_local=23, incidents=[], places=[], reports=[])
    assert base.risk_score == int(round(sum(f.points for f in base.features)))
    payload = base.to_dict()
    assert payload["safetyScore"] == 100 - payload["riskScore"]
    assert payload["coverage"]["observedFeatures"] == sum(1 for f in payload["features"] if f["observed"])


def test_demo_script_is_a_deterministic_four_minute_walkthrough(authed):
    body = authed.get("/api/demo/script").get_json()
    assert body["totalSeconds"] <= 300, "the judge walkthrough must fit in the timebox"
    assert body["targetSeconds"] == 240
    assert len(body["script"]) == 10
    assert all(step["route"] for step in body["script"]), "every step names the screen it belongs to"
    ids = {step["id"] for step in body["script"]}
    assert {"dashboard", "score", "why", "routes", "journey", "change", "sos", "guardian", "timeline", "cancel"} <= ids
    assert all(step["say"] for step in body["script"]), "every step carries what to say"


def test_demo_script_order_is_the_product_story(authed):
    """The walkthrough is one coherent narrative, in this order, every time.

    A judge who follows the in-app guide and a judge who reads docs/JUDGE_DEMO.md
    must see the same sequence, so the order is asserted rather than described.
    """
    body = authed.get("/api/demo/script").get_json()
    assert [step["id"] for step in body["script"]] == [
        "dashboard", "score", "why", "routes", "journey", "change", "sos", "guardian", "timeline", "cancel",
    ]
    assert [step["step"] for step in body["script"]] == list(range(1, 11))
    assert body["story"].startswith("PREVENT")


def test_demo_script_steps_can_jump_to_a_specific_block(authed):
    """Steps that are about one block name an anchor, so the guide scrolls to the
    explanation rather than dumping the judge at the top of a long page."""
    body = authed.get("/api/demo/script").get_json()
    anchors = {step["id"]: step.get("anchor") for step in body["script"]}
    assert anchors["score"] == "#assessment-hero"
    assert anchors["why"] == "#assessment-why"
    assert anchors["change"] == "#assessment-change"
    # Not every step needs one: the SOS step is about a control, not a block.
    assert anchors["sos"] is None


def test_demo_reset_closes_open_emergency_and_journey(authed):
    authed.arm_and_activate()
    authed.post("/api/journeys", {"origin": "A", "destination": "B", "expectedMinutes": 30})
    body = authed.post("/api/demo/reset").get_json()
    assert body["reset"] is True
    assert body["kept"]

    assert authed.get("/api/sos/active").get_json()["incident"] is None
    assert authed.get("/api/journeys/active").get_json()["journey"] is None
    assert authed.get("/api/sos/incidents").get_json()["incidents"], "past incidents are kept"


# --------------------------------------------------------------- migration


def test_migrations_are_additive_and_idempotent(app, tmp_path):
    path = tmp_path / "migrate.db"
    db.init_db(path)
    conn = db.get_connection(path)
    applied = db.apply_migrations(conn)
    assert applied == [], "a migrated database must need no further changes"
    assert {"role", "deleted_at"} <= db._existing_columns(conn, "users")
    assert {"verified_by", "verification_code_hash", "verification_expires_at"} <= db._existing_columns(conn, "contacts")
    conn.close()