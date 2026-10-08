"""Notification delivery.

The single most important property of this module: **it cannot claim a message
was delivered unless a provider confirmed it.**

Every attempt resolves to exactly one status:

``sent``
    A real provider returned success.
``simulated``
    No provider is configured; the attempt was recorded in a local outbox and
    surfaced in the UI as *SIMULATED*. Never described as delivered.
``failed``
    A provider was configured and rejected/errored. Reported as failed.
``unavailable``
    No provider exists for this channel at all.
``skipped``
    The recipient or channel opted out.

Adding a provider (Twilio, MSG91, FCM, WhatsApp Cloud API) means writing one
class and registering it. No caller changes.
"""

from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol

STATUS_SENT = "sent"
STATUS_SIMULATED = "simulated"
STATUS_FAILED = "failed"
STATUS_UNAVAILABLE = "unavailable"
STATUS_SKIPPED = "skipped"

#: Human-readable, honest copy. The UI renders these strings verbatim.
STATUS_COPY = {
    STATUS_SENT: "Delivered by provider",
    STATUS_SIMULATED: "SIMULATED - recorded locally, no external message sent",
    STATUS_FAILED: "Failed to send",
    STATUS_UNAVAILABLE: "UNAVAILABLE - no provider configured for this channel",
    STATUS_SKIPPED: "Skipped - recipient opted out of this channel",
}


@dataclass
class DeliveryResult:
    channel: str
    provider: str
    destination: str
    status: str
    detail: str = ""
    provider_message_id: str | None = None

    @property
    def delivered(self) -> bool:
        return self.status == STATUS_SENT

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "provider": self.provider,
            "destination": self.destination,
            "status": self.status,
            "delivered": self.delivered,
            "detail": self.detail,
            "message": STATUS_COPY.get(self.status, self.status),
        }


class NotificationProvider(Protocol):
    name: str
    channel: str

    def is_configured(self) -> bool: ...
    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult: ...


class SimulatedProvider:
    """Local outbox. Records the attempt; sends nothing.

    This exists so the product is demonstrable end-to-end without credentials,
    while remaining unambiguous about the fact that nothing left the machine.
    """

    def __init__(self, channel: str, name: str = "simulated"):
        self.channel = channel
        self.name = name

    def is_configured(self) -> bool:
        return True

    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult:
        return DeliveryResult(
            channel=self.channel,
            provider=self.name,
            destination=destination,
            status=STATUS_SIMULATED,
            detail="No provider credentials configured. Attempt recorded in the local outbox.",
        )


class _HttpProviderBase:
    def __init__(self, channel: str, name: str, timeout: float = 8.0):
        self.channel = channel
        self.name = name
        self.timeout = timeout

    def is_configured(self) -> bool:  # pragma: no cover - overridden
        return False

    def _post_form(self, url: str, data: dict[str, str], headers: dict[str, str] | None = None) -> tuple[int, str]:
        body = urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")


class TwilioSmsProvider(_HttpProviderBase):
    """Real SMS via Twilio. Activates only when credentials are present."""

    def __init__(self, account_sid: str, auth_token: str, from_number: str, timeout: float = 8.0):
        super().__init__("sms", "twilio", timeout)
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.from_number = from_number

    def is_configured(self) -> bool:
        return bool(self.account_sid and self.auth_token and self.from_number)

    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult:
        if not self.is_configured():
            return DeliveryResult("sms", self.name, destination, STATUS_UNAVAILABLE, "Missing Twilio credentials.")
        import base64

        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json"
        auth = base64.b64encode(f"{self.account_sid}:{self.auth_token}".encode()).decode()
        try:
            status, raw = self._post_form(
                url,
                {"To": destination, "From": self.from_number, "Body": body},
                {"Authorization": f"Basic {auth}"},
            )
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return DeliveryResult("sms", self.name, destination, STATUS_FAILED, f"Network error: {exc.__class__.__name__}")
        if 200 <= status < 300:
            return DeliveryResult("sms", self.name, destination, STATUS_SENT, "Accepted by provider.", raw[:120])
        return DeliveryResult("sms", self.name, destination, STATUS_FAILED, f"Provider returned HTTP {status}.")


class Msg91SmsProvider(_HttpProviderBase):
    """Real SMS via MSG91 (commonly used in India)."""

    def __init__(self, auth_key: str, sender_id: str, template_id: str = "", timeout: float = 8.0):
        super().__init__("sms", "msg91", timeout)
        self.auth_key = auth_key
        self.sender_id = sender_id
        self.template_id = template_id

    def is_configured(self) -> bool:
        return bool(self.auth_key and self.sender_id)

    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult:
        if not self.is_configured():
            return DeliveryResult("sms", self.name, destination, STATUS_UNAVAILABLE, "Missing MSG91 credentials.")
        payload: dict[str, str] = {
            "authkey": self.auth_key,
            "mobiles": destination.lstrip("+"),
            "sender": self.sender_id,
            "message": body,
        }
        if self.template_id:
            payload["template_id"] = self.template_id
        try:
            status, raw = self._post_form("https://control.msg91.com/api/v5/flow/", payload)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return DeliveryResult("sms", self.name, destination, STATUS_FAILED, f"Network error: {exc.__class__.__name__}")
        if 200 <= status < 300:
            return DeliveryResult("sms", self.name, destination, STATUS_SENT, "Accepted by provider.", raw[:120])
        return DeliveryResult("sms", self.name, destination, STATUS_FAILED, f"Provider returned HTTP {status}.")


class TwilioWhatsAppProvider(TwilioSmsProvider):
    def __init__(self, account_sid: str, auth_token: str, from_number: str, timeout: float = 8.0):
        super().__init__(account_sid, auth_token, from_number, timeout)
        self.channel = "whatsapp"
        self.name = "twilio_whatsapp"
        self.from_number = f"whatsapp:{from_number}"

    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult:
        to = destination if destination.startswith("whatsapp:") else f"whatsapp:{destination}"
        result = super().send(to, body, context)
        result.channel = "whatsapp"
        result.provider = self.name
        result.destination = destination
        return result


class UnavailableProvider:
    """No provider exists for this channel. Used for ``call`` and ``push`` by default."""

    def __init__(self, channel: str):
        self.channel = channel
        self.name = "none"

    def is_configured(self) -> bool:
        return False

    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult:
        return DeliveryResult(
            self.channel,
            self.name,
            destination,
            STATUS_UNAVAILABLE,
            "SheSafe has no outbound capability for this channel. The user must initiate it on their device.",
        )


# ------------------------------------------------------------- registry


@dataclass
class Registry:
    """Provider registry. Populated from config at app start."""

    providers: dict[str, Any] = field(default_factory=dict)

    def register(self, channel: str, provider: Any) -> None:
        self.providers[channel] = provider

    def get(self, channel: str) -> Any:
        return self.providers.get(channel, UnavailableProvider(channel))

    def describe(self) -> list[dict[str, Any]]:
        out = []
        for channel, provider in sorted(self.providers.items()):
            configured = False
            try:
                configured = bool(provider.is_configured())
            except Exception:  # pragma: no cover
                configured = False
            real = configured and not isinstance(provider, SimulatedProvider)
            out.append(
                {
                    "channel": channel,
                    "provider": provider.name,
                    "configured": configured,
                    "mode": "real" if real else "simulated",
                    "note": STATUS_COPY[STATUS_SENT] if real else (
                        STATUS_COPY[STATUS_SIMULATED] if isinstance(provider, SimulatedProvider)
                        else STATUS_COPY[STATUS_UNAVAILABLE]
                    ),
                }
            )
        return out


def build_registry(config) -> Registry:
    """Choose the best available provider per channel, honestly."""
    registry = Registry()
    timeout = float(config.get("EXTERNAL_HTTP_TIMEOUT", 8.0))

    # --- SMS: real provider > simulated outbox
    sms_provider_choice = (config.get("SMS_PROVIDER") or "none").lower()
    real_sms: Any | None = None
    if sms_provider_choice == "twilio" and all(
        config.get(k) for k in ("SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_FROM")
    ):
        real_sms = TwilioSmsProvider(config["SMS_ACCOUNT_SID"], config["SMS_AUTH_TOKEN"], config["SMS_FROM"], timeout)
    elif sms_provider_choice == "msg91" and all(
        config.get(k) for k in ("MSG91_AUTH_KEY", "MSG91_SENDER_ID")
    ):
        real_sms = Msg91SmsProvider(config["MSG91_AUTH_KEY"], config["MSG91_SENDER_ID"], timeout=timeout)
    registry.register("sms", real_sms or SimulatedProvider("sms"))

    # --- WhatsApp: real provider > simulated outbox
    wa_choice = (config.get("WHATSAPP_PROVIDER") or "none").lower()
    if wa_choice == "twilio" and all(
        config.get(k) for k in ("SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_FROM")
    ):
        registry.register(
            "whatsapp",
            TwilioWhatsAppProvider(config["SMS_ACCOUNT_SID"], config["SMS_AUTH_TOKEN"], config["SMS_FROM"], timeout),
        )
    else:
        registry.register("whatsapp", SimulatedProvider("whatsapp"))

    # --- Call: the *user's phone* dials. The server can never place a call.
    registry.register("call", UnavailableProvider("call"))

    # --- Push: register a real provider when credentials exist.
    push_choice = (config.get("PUSH_PROVIDER") or "none").lower()
    if push_choice == "fcm" and config.get("FCM_SERVER_KEY"):
        registry.register("push", _FcmPushProvider(config["FCM_SERVER_KEY"], timeout))
    else:
        registry.register("push", SimulatedProvider("push"))

    return registry


class _FcmPushProvider(_HttpProviderBase):
    """Firebase Cloud Messaging legacy HTTP push. Requires FCM_SERVER_KEY."""

    def __init__(self, server_key: str, timeout: float = 8.0):
        super().__init__("push", "fcm", timeout)
        self.server_key = server_key

    def is_configured(self) -> bool:
        return bool(self.server_key)

    def send(self, destination: str, body: str, context: dict[str, Any]) -> DeliveryResult:
        import json

        payload = {
            "to": destination,
            "priority": "high",
            "notification": {"title": context.get("title", "SheSafe"), "body": body},
            "data": {"incident_id": context.get("incident_id", "")},
        }
        req = urllib.request.Request(
            "https://fcm.googleapis.com/fcm/send",
            data=json.dumps(payload).encode(),
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"key={self.server_key}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                status = response.status
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            return DeliveryResult("push", self.name, destination, STATUS_FAILED, f"Network error: {exc.__class__.__name__}")
        if 200 <= status < 300:
            return DeliveryResult("push", self.name, destination, STATUS_SENT, "Accepted by FCM.")
        return DeliveryResult("push", self.name, destination, STATUS_FAILED, f"FCM returned HTTP {status}.")


# ------------------------------------------------------- message building


def build_emergency_message(
    *,
    user_name: str,
    reference: str,
    lat: float | None,
    lng: float | None,
    accuracy_m: float | None,
    share_url: str | None,
    triggered_at: str,
) -> str:
    """Plain-text emergency body. Short, unambiguous, no marketing language."""
    lines = [
        f"URGENT - SheSafe alert from {user_name}",
        f"Incident reference: {reference}",
        f"Time (UTC): {triggered_at}",
    ]
    if lat is not None and lng is not None:
        accuracy = f" (+/-{int(round(accuracy_m))}m)" if accuracy_m else ""
        lines.append(f"Location: {lat:.5f}, {lng:.5f}{accuracy}")
        lines.append(f"Map: https://www.openstreetmap.org/?mlat={lat}&mlon={lng}#map=17/{lat:.5f}/{lng:.5f}")
    else:
        lines.append("Location: not yet available")
    if share_url:
        lines.append(f"Live tracking: {share_url}")
    lines.append("SheSafe has NOT contacted police on your behalf. If this is an emergency, call 112 now.")
    return "\n".join(lines)


def build_safe_message(*, user_name: str, reference: str, resolved_at: str) -> str:
    return (
        f"SheSafe update - {user_name} has confirmed they are safe.\n"
        f"Incident {reference} was stood down at {resolved_at} (UTC).\n"
        "If you believe this is an error, contact them directly and call 112 if needed."
    )


def build_check_in_message(*, user_name: str, place_label: str | None, journey_id: str | None) -> str:
    destination = place_label or "their current location"
    suffix = f" (journey {journey_id})" if journey_id else ""
    return f"SheSafe: {user_name} has checked in as safe at {destination}{suffix}."