"""Incident classification and guidance.

Two layers, in strict priority order:

1. **Deterministic baseline (always available).** A transparent keyword + rule
   classifier. It works offline, is unit-tested, and is what powers the feature
   when no AI provider is configured. Its output is labelled
   ``classifier: rule_based_v1``.
2. **Optional LLM layer.** Only used when ``SHESAFE_AI_PROVIDER`` is configured.
   Any error, timeout or malformed response falls back to layer 1. AI output is
   advisory, is flagged ``advisory: true``, and **can never trigger or gate an
   SOS** — SOS is a deterministic button press with no AI in the path.

There is no chatbot here on purpose. A person pressing an SOS button is not
debugging a conversation.
"""

from __future__ import annotations

from typing import Any

CLASSIFIER_VERSION = "rule_based_v1"

CATEGORIES = (
    "stalking",
    "harassment",
    "eve_teasing",
    "theft",
    "assault",
    "unsafe_area",
    "medical",
    "accident",
    "domestic_violence",
    "other",
)

SEVERITY_ORDER = {"low": 0, "moderate": 1, "high": 2, "critical": 3}

# Keyword -> (category, weight, severity hint)
_RULES: list[tuple[tuple[str, ...], str, float, str | None]] = [
    (("following", "followed", "stalk", "stalker", "trailing"), "stalking", 0.95, "high"),
    (("eve teasing", "eve-teasing", "eve teasing", "catcall", "lewd", "comments"), "harassment", 0.8, "high"),
    (("harass", "abuse", "trolled", "shouted", "obscene"), "harassment", 0.75, "moderate"),
    (("threatening", "threat", "weapon", "knife", "gun", "followed by men"), "assault", 0.95, "critical"),
    (("grabbed", "touched", "pushed", "hit", "slapped", "assaulted", "molest"), "assault", 0.98, "critical"),
    (("drunk", "inebriated", "intoxicated"), "unsafe_area", 0.7, "moderate"),
    (("stolen", "stole", "snatched", "bag taken", "pickpocket", "robbed"), "theft", 0.9, "high"),
    (("dark", "no light", "streetlight", "unlit", "isolated", "deserted", "empty street", "underpass"), "unsafe_area", 0.7, None),
    (("injured", "bleeding", "pain", "fainted", "unconscious", "chest pain", "pregnant", "medical"), "medical", 0.9, "critical"),
    (("accident", "fell", "fall", "hit by", "crashed", "injur"), "accident", 0.9, "high"),
    (("husband", "in-laws", "in laws", "domestic", "beat me", "home violence"), "domestic_violence", 0.95, "critical"),
    (("leaving", "moving out", "marriage"), "domestic_violence", 0.7, None),
    (("waiting", "stopped", "asking", "catcalls"), "eve_teasing", 0.6, "moderate"),
]

ADVICE: dict[str, list[str]] = {
    "stalking": [
        "Do not go home if you believe you are being followed; go to an open, staffed place.",
        "Call a trusted person and stay on a call while you move.",
        "Note distinguishing details (vehicle number, clothing) without confronting them.",
        "If they close in, call 112.",
    ],
    "harassment": [
        "Move to a populated, well-lit place with staff or other women present.",
        "Avoid engaging; continue towards a staffed location.",
        "Share your live location with a trusted contact.",
    ],
    "eve_teasing": [
        "Continue walking; do not stop or respond.",
        "Move towards a shop, café or police booth where CCTV is likely.",
        "If they follow, escalate to treating it as stalking.",
    ],
    "theft": [
        "Do not chase or confront. Step away from the immediate danger first.",
        "Move to a safe place and call 112 if there is a risk of harm.",
        "Do not follow up alone to recover property.",
    ],
    "assault": [
        "Get to safety first; distance and other people matter more than belongings.",
        "Call 112 as soon as you can.",
        "Do not wash or change clothes before a medical examination if you intend to report.",
        "A hospital can treat injuries and document them.",
    ],
    "unsafe_area": [
        "Prefer the main road rather than the shorter unlit stretch.",
        "Stay on a phone call so someone knows where you are.",
        "If it feels unsafe, turn back - arriving late is better than not arriving.",
    ],
    "medical": [
        "Call 108 or 112 for an ambulance.",
        "If you are alone, unlock your door and stay near a window or common area.",
        "Share your live location so a responder can find you.",
    ],
    "accident": [
        "Call 112 and 108; do not move an injured person unless they are in further danger.",
        "Switch on hazard lights and place something reflective behind the vehicle.",
    ],
    "domestic_violence": [
        "If it is safe to do so, contact the National Women Helpline on 181.",
        "A One-Stop Centre can provide shelter, medical aid and legal support.",
        "Keep your phone charged and somewhere you can reach it safely.",
    ],
    "other": [
        "Move to a populated, well-lit place.",
        "Share your live location with a trusted contact.",
        "If you are in immediate danger call 112.",
    ],
}

# Words that mean the person needs a responder now, not advice.
_URGENT_MARKERS = ("help", "emergency", "dying", "bleeding", "unconscious", "attacked", "trapped", "followed", "knife")


def classify(text: str | None) -> dict[str, Any]:
    """Deterministic classification. Always returns a result."""
    lowered = (text or "").strip().lower()
    if not lowered:
        return _result([], 0.0, "low", 0.0, "No description supplied.", "other")

    scores: dict[str, float] = {}
    evidence: dict[str, str] = {}
    matched: list[str] = []
    for keywords, category, weight, _severity in _RULES:
        for keyword in keywords:
            if keyword in lowered:
                matched.append(keyword)
                scores[category] = scores.get(category, 0.0) + weight
                evidence.setdefault(category, keyword)

    if not scores:
        return _result([], 0.0, "low", 0.15, "No rule matched the description.", "other")

    category = max(scores, key=lambda k: scores[k])
    strength = min(1.0, scores[category])
    severity = _severity_for(category, lowered)
    confidence = round(min(0.95, 0.35 + 0.2 * strength + 0.05 * len(matched)), 2)
    keyword = evidence.get(category, category)
    reason = f"Matched {len(matched)} rule keyword(s), strongest signal '{keyword}' for '{category}'."
    return _result(sorted(set(matched)), strength, severity, confidence, reason, category)


def _severity_for(category: str, lowered: str) -> str:
    if any(marker in lowered for marker in ("help", "emergency", "dying", "unconscious")):
        return "critical"
    if category in {"assault", "domestic_violence", "stalking", "theft", "medical", "accident"}:
        return "high"
    if category in {"harassment", "eve_teasing"}:
        return "high" if any(w in lowered for w in ("repeated", "again", "following", "group")) else "moderate"
    if category == "unsafe_area":
        return "moderate"
    return "low"


def _result(
    matched: list[str],
    strength: float,
    severity: str,
    confidence: float,
    reason: str,
    category: str,
) -> dict[str, Any]:
    return {
        "classifier": CLASSIFIER_VERSION,
        "category": category,
        "categoryLabel": category.replace("_", " ").title(),
        "severity": severity.lower(),
        "confidence": round(confidence, 2),
        "matchedKeywords": matched[:8],
        "reason": reason,
        "recommendedActions": ADVICE.get(category, ADVICE["other"]),
        "advisory": True,
        "authoritative": False,
        "disclaimer": (
            "Automated classification is guidance only. It is not an emergency response and "
            "does not contact anyone. If you are in danger, press SOS or call 112."
        ),
        "triggersUrgency": any(marker in " ".join(matched) for marker in _URGENT_MARKERS),
    }


def summarise(incident: dict[str, Any]) -> dict[str, Any]:
    """Short, factual incident summary built from stored fields only.

    No generative claims: the summary restates recorded facts so a responder or
    supporter reads the same thing the reporter wrote.
    """
    started = incident.get("started_at") or incident.get("created_at")
    when = started[:16].replace("T", " ") + " UTC" if started else "unknown time"
    who = incident.get("user_name") or "A SheSafe user"
    outcome = incident.get("outcome") or incident.get("state")
    duration = incident.get("durationMinutes")
    parts = [
        f"{who} raised a SheSafe emergency alert at {when}.",
        f"Final state: {str(outcome).replace('_', ' ').title()}.",
    ]
    if duration:
        parts.append(f"Duration: {int(duration)} minutes.")
    anchor = incident.get("location")
    if anchor and anchor.get("lat") is not None:
        parts.append(
            f"Anchor coordinates {anchor['lat']:.5f}, {anchor['lng']:.5f}"
            + (f" (+/-{int(anchor['accuracy_m'])}m)." if anchor.get("accuracy_m") else ".")
        )
    else:
        parts.append("No coordinates were captured for this incident.")
    notifications = incident.get("notifications") or []
    if notifications:
        sent = sum(1 for n in notifications if n.get("delivered"))
        simulated = sum(1 for n in notifications if n.get("status") == "simulated")
        unavailable = sum(1 for n in notifications if n.get("status") == "unavailable")
        parts.append(
            f"Notifications: {sent} delivered, {simulated} simulated, {unavailable} unavailable."
        )
        parts.append("SheSafe did not contact police on the user's behalf.")
    return {
        "summary": " ".join(parts),
        "generatedBy": "template_v1",
        "advisory": True,
        "note": "Derived only from recorded incident fields; no generative model involved.",
    }


def quick_actions(severity: str, *, has_location: bool, contact_count: int) -> list[dict[str, str]]:
    """Deterministic next-best-actions. Always available, never AI-dependent."""
    actions: list[dict[str, str]] = []
    if severity.lower() in {"critical", "high"}:
        actions.append({"label": "Call 112", "hint": "Opens your phone dialler. SheSafe cannot place the call."})
    actions.append({"label": "Start live location sharing", "hint": "Gives your contacts a link to follow you."})
    if contact_count == 0:
        actions.append({"label": "Add a trusted contact", "hint": "Nobody is currently configured to be alerted."})
    elif contact_count <= 2:
        actions.append({"label": "Add another trusted contact", "hint": "More contacts means faster, wider alerting."})
    actions.append({"label": "Share your trip with Journey Guard", "hint": "Escalates if you do not check in."})
    if has_location:
        actions.append({"label": "View nearest safe places", "hint": "Real facilities near your current position."})
    return actions