"""Safety Intelligence API: point assessment, routes, places, AI incident help.

Every response in this blueprint carries provenance so the UI can label real vs
heuristic vs simulated data instead of presenting everything with equal
confidence.
"""

from __future__ import annotations

from flask import Blueprint, current_app, request

from .. import geo, validation
from ..errors import ValidationError
from ..security import login_required, rate_limit, require_user
from ..validation import require_json
from .helpers import db_path, ok, public_location

bp = Blueprint("intelligence", __name__, url_prefix="/api/intelligence")


@bp.get("/assess")
@rate_limit("read")
@login_required
def assess():
    """Risk score for a point. Defaults to the user's last known position."""
    user = require_user()
    dbp = db_path()
    lat = validation.query_float(request.args, "lat", lo=-90, hi=90, default=None)
    lng = validation.query_float(request.args, "lng", lo=-180, hi=180, default=None)
    if (lat is None) != (lng is None):
        raise ValidationError("Supply both lat and lng, or neither.", lat="incomplete")
    if lat is None:
        sample = _latest(dbp, user["id"])
        if sample is None:
            raise ValidationError(
                "No location available yet. Enable location, or pass lat and lng explicitly.",
                location="unavailable",
            )
        lat, lng = sample["lat"], sample["lng"]

    radius = validation.query_float(request.args, "radiusKm", lo=0.2, hi=25, default=2.0)
    from .. import intelligence

    payload = intelligence.assess_point(
        db_path=dbp, config=current_app.config, lat=lat, lng=lng, radius_km=radius, user_id=user["id"]
    )
    payload["location"] = {"lat": lat, "lng": lng}
    return ok({"assessment": payload})


@bp.get("/explain")
@rate_limit("read")
@login_required
def explain():
    """The engine's own description of itself - weights, version, caveats."""
    from ..intelligence import scoring

    return ok(
        {
            "engine": {
                "model": scoring.MODEL_VERSION,
                "description": scoring.__doc__.strip().splitlines()[0],
                "weights": scoring.WEIGHTS,
                "bands": [
                    {"label": label, "min": low, "max": high, "key": key} for low, high, label, key in scoring.BANDS
                ],
                "scoreSemantics": "riskScore 0-100, higher = more risk. safetyScore = 100 - riskScore.",
                "limitations": [
                    "Not a trained machine-learning model; no accuracy measurement is claimed.",
                    "No street-lighting, CCTV or occupancy data is available to SheSafe.",
                    "Incident history is SheSafe's own records only; there is no third-party crime dataset.",
                    "Community reports are crowd-sourced and down-weighted until reviewed.",
                ],
            }
        }
    )


@bp.post("/routes")
@rate_limit("external")
@login_required
def routes():
    """Candidate routes with safety scores, labelled fastest/safest/balanced."""
    user = require_user()
    body = require_json(request)
    from_lat = validation.lat_field(body, "fromLat")
    from_lng = validation.lng_field(body, "fromLng")
    to_lat = validation.lat_field(body, "toLat")
    to_lng = validation.lng_field(body, "toLng")
    mode = validation.enum_field(body, "mode", {"walk", "cycle", "drive"}, required=False, default="walk", label="Travel mode")

    if abs(from_lat - to_lat) < 1e-7 and abs(from_lng - to_lng) < 1e-7:
        raise ValidationError("Start and destination are the same point.", toLat="same_as_origin")

    dbp = db_path()
    from .. import intelligence

    result = intelligence.plan_routes(
        db_path=dbp,
        config=current_app.config,
        origin=(from_lat, from_lng),
        destination=(to_lat, to_lng),
        mode=mode or "walk",
        user_id=user["id"],
    )
    result["origin"] = {"lat": from_lat, "lng": from_lng}
    result["destination"] = {"lat": to_lat, "lng": to_lng}
    result["disclaimer"] = (
        "'Safest' means lower modelled risk under the published rules for this point in time. "
        "It is not a guarantee of safety."
    )
    return ok(result)


@bp.get("/places")
@rate_limit("external")
@login_required
def places():
    """Nearby safe places from OpenStreetMap, with real provenance."""
    user = require_user()
    dbp = db_path()
    lat = validation.query_float(request.args, "lat", lo=-90, hi=90, default=None)
    lng = validation.query_float(request.args, "lng", lo=-180, hi=180, default=None)
    if lat is None or lng is None:
        sample = _latest(dbp, user["id"])
        if sample is None:
            raise ValidationError("No location available yet. Enable location or pass lat and lng.", location="unavailable")
        lat, lng = sample["lat"], sample["lng"]

    radius = validation.query_float(request.args, "radiusKm", lo=0.5, hi=25, default=10.0)
    categories = request.args.get("categories")
    category_list = [c.strip() for c in categories.split(",")] if categories else None

    from .. import intelligence

    payload = intelligence.describe_places(
        db_path=dbp, config=current_app.config, lat=lat, lng=lng, categories=category_list, radius_km=radius
    )
    payload["origin"] = {"lat": lat, "lng": lng}
    return ok(payload)


@bp.post("/incident-assist")
@rate_limit("external")
@login_required
def incident_assist():
    """Classification + guidance for a written incident description.

    Advisory only. This endpoint cannot raise an SOS and never contacts anyone.
    """
    user = require_user()
    body = require_json(request)
    text = validation.field(body, "description", max_length=2000, label="Description")
    dbp = db_path()

    from .. import intelligence

    sample = _latest(dbp, user["id"])
    result = intelligence.incident_intelligence(
        db_path=dbp,
        config=current_app.config,
        text=text,
        incident={
            "user_id": user["id"],
            "user_name": user["name"],
            "state": "REPORTED",
            "created_at": None,
            "location": public_location(sample),
            "notifications": [],
        },
    )

    result["quickActions"] = _quick_actions(result["severity"], bool(sample), _contact_count(dbp, user["id"]))
    result["sosAvailable"] = True
    result["note"] = "This is guidance. Press SOS or call 112 for an actual emergency."
    return ok({"assist": result})


def _quick_actions(severity, has_location, contact_count):
    from ..intelligence.classifiers import quick_actions

    return quick_actions(severity, has_location=has_location, contact_count=contact_count)


def _contact_count(dbp, user_id: str) -> int:
    from .. import repo

    return len(repo.active_contacts(dbp, user_id))


def _latest(dbp, user_id: str):
    from .. import repo

    return repo.latest_location(dbp, user_id)