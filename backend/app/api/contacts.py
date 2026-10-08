"""Emergency contacts CRUD — owner-scoped, validated, per-channel preferences."""

from __future__ import annotations

from flask import Blueprint, g, request

from .. import repo, validation
from ..errors import NotFoundError
from ..logging_utils import audit
from ..security import login_required, rate_limit, require_user
from ..validation import require_json
from .helpers import audit_kwargs, db_path, ok, public_contact

bp = Blueprint("contacts", __name__, url_prefix="/api/contacts")

ALLOWED_CHANNELS = ("sms", "whatsapp", "call", "push")
RELATIONSHIPS = (
    "Mother", "Father", "Sister", "Brother", "Friend", "Colleague", "Partner",
    "Neighbour", "Relative", "Guardian", "Roommate", "Other",
)


@bp.get("")
@rate_limit("read")
@login_required
def list_all():
    user = require_user()
    dbp = db_path()
    contacts = repo.list_contacts(dbp, user["id"])
    return ok(
        {
            "contacts": [public_contact(c) for c in contacts],
            "channels": list(ALLOWED_CHANNELS),
            "count": len(contacts),
            "activeCount": sum(1 for c in contacts if c["active"]),
        }
    )


@bp.post("")
@rate_limit("write")
@login_required
def create():
    user = require_user()
    dbp = db_path()
    body = require_json(request)
    data = _parse(body)
    contact = repo.create_contact(dbp, user["id"], data)
    audit(
        dbp,
        action="contact.create",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact["id"],
        detail={"channels": contact["channels"]},
        **audit_kwargs(),
    )
    return ok({"contact": public_contact(contact)}, 201)


@bp.patch("/<contact_id>")
@rate_limit("write")
@login_required
def update(contact_id: str):
    user = require_user()
    dbp = db_path()
    body = require_json(request)
    if repo.get_contact(dbp, user["id"], contact_id) is None:
        raise NotFoundError("Contact not found.")
    patch = _parse(body, partial=True)
    contact = repo.update_contact(dbp, user["id"], contact_id, patch)
    audit(
        dbp,
        action="contact.update",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact_id,
        detail={"fields": sorted(patch)},
        **audit_kwargs(),
    )
    return ok({"contact": public_contact(contact)})


@bp.delete("/<contact_id>")
@rate_limit("write")
@login_required
def delete(contact_id: str):
    user = require_user()
    dbp = db_path()
    if not repo.delete_contact(dbp, user["id"], contact_id):
        raise NotFoundError("Contact not found.")
    audit(
        dbp,
        action="contact.delete",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact_id,
        **audit_kwargs(),
    )
    return ok({"message": "Contact removed."})


@bp.post("/<contact_id>/verify")
@rate_limit("write")
@login_required
def verify(contact_id: str):
    """Mark a contact as verified.

    In this build verification records that the user has confirmed the number
    belongs to them. SheSafe does not perform SMS/WhatsApp ownership
    verification, so the response states that explicitly.
    """
    user = require_user()
    dbp = db_path()
    contact = repo.get_contact(dbp, user["id"], contact_id)
    if contact is None:
        raise NotFoundError("Contact not found.")
    updated = repo.update_contact(dbp, user["id"], contact_id, {"verified": True})
    audit(
        dbp,
        action="contact.verify",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact_id,
        **audit_kwargs(),
    )
    return ok(
        {
            "contact": public_contact(updated),
            "note": "Self-confirmed. SheSafe cannot independently verify phone ownership.",
        }
    )


def _parse(body: dict, *, partial: bool = False) -> dict:
    data: dict = {}
    if not partial or "name" in body:
        data["name"] = validation.field(body, "name", required=not partial, max_length=80, pattern=validation.NAME_RE)
    if not partial or "phone" in body:
        data["phone"] = validation.phone_field(body, "phone", required=not partial)
    if not partial or "relationship" in body:
        data["relationship"] = validation.enum_field(
            body, "relationship", RELATIONSHIPS, required=False, default="Other", label="Relationship"
        )
    if "channels" in body:
        channels = body.get("channels")
        if not isinstance(channels, list) or not channels:
            from ..errors import ValidationError

            raise ValidationError("Choose at least one notification channel.", channels="required")
        invalid = [c for c in channels if c not in ALLOWED_CHANNELS]
        if invalid:
            from ..errors import ValidationError

            raise ValidationError(
                f"Unsupported channel(s): {', '.join(invalid)}.", channels="invalid"
            )
        data["channels"] = sorted(set(channels))
    elif not partial:
        data["channels"] = ["sms", "call"]
    if "isPrimary" in body:
        data["is_primary"] = validation.bool_field(body, "isPrimary")
    elif not partial:
        data["is_primary"] = False
    if "active" in body:
        data["active"] = validation.bool_field(body, "active", default=True)
    if "verified" in body:
        data["verified"] = validation.bool_field(body, "verified")
    return {k: v for k, v in data.items() if v is not None}