"""Emergency contacts CRUD — owner-scoped, validated, per-channel preferences."""

from __future__ import annotations

import hmac
import secrets
from datetime import datetime, timezone

from flask import Blueprint, current_app, g, request

from .. import repo, validation
from ..errors import NotFoundError, ValidationError
from ..logging_utils import audit, iso
from ..notifications import build_verification_message
from ..security import hash_token, login_required, rate_limit, require_user
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
    """Mark a contact as self-confirmed by the account holder.

    This is deliberately *not* called "verified" in the UI: SheSafe records that
    the person using the account says they checked the number with the contact.
    SheSafe cannot check it herself. Provider-backed verification is a separate
    endpoint with its own state.
    """
    user = require_user()
    dbp = db_path()
    contact = repo.get_contact(dbp, user["id"], contact_id)
    if contact is None:
        raise NotFoundError("Contact not found.")
    updated = repo.update_contact(
        dbp,
        user["id"],
        contact_id,
        {"verified": 1, "verified_by": "user", "verified_at": iso()},
    )
    audit(
        dbp,
        action="contact.verify",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact_id,
        detail={"method": "self_confirmed"},
        **audit_kwargs(),
    )
    return ok(
        {
            "contact": public_contact(updated),
            "note": "Self-confirmed. SheSafe cannot independently verify phone ownership.",
        }
    )


@bp.post("/<contact_id>/verification")
@rate_limit("auth")
@login_required
def request_verification(contact_id: str):
    """Send a one-time code to a contact so they can prove they own the number.

    Production path
    ---------------
    With a messaging provider configured the code is delivered over SMS/WhatsApp
    and the attempt is recorded with ``status: sent``. With no provider the
    attempt is recorded as ``simulated`` and the response says so; the code is
    still generated so the flow is demonstrable end to end without pretending
    anything was delivered.

    Only a SHA-256 hash of the code is stored, exactly like a password, so a
    database leak cannot be replayed to impersonate a contact.
    """
    user = require_user()
    dbp = db_path()
    contact = repo.get_contact(dbp, user["id"], contact_id)
    if contact is None:
        raise NotFoundError("Contact not found.")

    ttl = int(current_app.config["CONTACT_VERIFICATION_TTL_SECONDS"])
    code = f"{secrets.randbelow(10 ** 6):06d}"
    registry = current_app.extensions["shesafe_notifications"]
    provider = registry.get("sms")

    body = build_verification_message(
        contact_name=contact["name"],
        user_name=user.get("name") or "A SheSafe user",
        code=code,
        ttl_minutes=max(1, ttl // 60),
    )
    result = provider.send(contact["phone"], body, {"purpose": "contact_verification", "contact_id": contact_id})

    repo.record_notification(
        dbp,
        incident_id=None,
        user_id=user["id"],
        contact_id=contact_id,
        channel="sms",
        provider=result.provider,
        destination=result.destination,
        body_preview=None,
        status=result.status,
        detail="contact verification code",
    )
    repo.start_contact_verification(
        dbp, user["id"], contact_id, code_hash=hash_token(code), ttl_seconds=ttl, provider=result.provider
    )

    audit(
        dbp,
        action="contact.verification_request",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact_id,
        detail={"provider": result.provider, "status": result.status},
        **audit_kwargs(),
    )
    return ok(
        {
            "verification": {
                # The code is returned only in simulated mode, where nothing was
                # actually delivered and there is otherwise no way to exercise
                # the confirmation step. It is never returned when a real
                # provider accepted the message.
                "mode": result.status,
                "provider": result.provider,
                "channel": "sms",
                "expiresInSeconds": ttl,
                "code": code if result.status != "sent" else None,
                "statement": (
                    "A one-time code was delivered by the provider. Ask the contact to read it back."
                    if result.status == "sent"
                    else "SIMULATED: no messaging provider is configured, so no code was delivered. "
                    "The code below was generated locally for demonstration."
                ),
            },
            "contact": public_contact(repo.get_contact(dbp, user["id"], contact_id)),
        },
        201,
    )


@bp.post("/<contact_id>/verification/confirm")
@rate_limit("auth")
@login_required
def confirm_verification(contact_id: str):
    """Read back the one-time code and mark the contact provider-verified."""
    user = require_user()
    dbp = db_path()
    contact = repo.get_contact(dbp, user["id"], contact_id)
    if contact is None:
        raise NotFoundError("Contact not found.")
    if not contact.get("verification_code_hash"):
        raise ValidationError("There is no verification in progress for this contact.", code="no_verification_pending")

    body = require_json(request)
    supplied = validation.field(body, "code", max_length=12, label="Verification code").strip()

    expires = contact.get("verification_expires_at")
    if expires and _parse_iso(expires) is not None and _parse_iso(expires) < datetime.now(timezone.utc):
        repo.clear_contact_verification(dbp, user["id"], contact_id, revoke_verified=False)
        raise ValidationError("That code has expired. Request a new one.", code="verification_expired")

    attempts = repo.record_verification_attempt(dbp, user["id"], contact_id)
    if attempts > int(current_app.config["CONTACT_VERIFICATION_MAX_ATTEMPTS"]):
        repo.clear_contact_verification(dbp, user["id"], contact_id, revoke_verified=False)
        raise ValidationError("Too many incorrect codes. Request a new one.", code="too_many_attempts")

    if not hmac.compare_digest(hash_token(supplied), contact["verification_code_hash"]):
        audit(
            dbp,
            action="contact.verification_confirm",
            outcome="failure",
            actor_id=user["id"],
            target_type="contact",
            target_id=contact_id,
            detail={"reason": "code_mismatch", "attempts": attempts},
            **audit_kwargs(),
        )
        raise ValidationError("That code does not match.", code="code_mismatch")

    updated = repo.confirm_contact_verification(dbp, user["id"], contact_id)
    audit(
        dbp,
        action="contact.verification_confirm",
        outcome="success",
        actor_id=user["id"],
        target_type="contact",
        target_id=contact_id,
        detail={"attempts": attempts},
        **audit_kwargs(),
    )
    return ok(
        {
            "contact": public_contact(updated),
            "note": "A code delivered to this number was read back. SheSafe records this as provider-verified.",
        }
    )


def _parse_iso(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


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