"""Fraud analysis with Groq gpt-oss-120b.

Sends the latest transcript plus recent call context, receives strict JSON,
and applies a deterministic safety floor so a clear request for secrets
can never be scored as "safe" because of model variance.
"""
import json
import logging
import re

from app.config import LLM_MODEL, groq_client
from app.schemas import SCAM_TYPES, LLMFraudAnalysis
from app.utils.prompts import SYSTEM_PROMPT, build_user_prompt

log = logging.getLogger(__name__)

NONE_LABELS = {"", "none", "no scam", "n/a", "safe", "unknown"}

# Safety-net patterns (case-insensitive, whole words)
SECRET_REQUEST = re.compile(
    r"\b(otp|one[- ]time password|pin|cvv|password|passcode|card number|aadhaar|upi pin)\b", re.I
)
ACTION_VERB = re.compile(r"\b(share|tell|read|send|give|provide|enter|confirm|type|disclose)\b", re.I)
REMOTE_ACCESS = re.compile(r"\b(anydesk|teamviewer|quicksupport|remote access|screen ?share)\b", re.I)
FLOOR_SCORE = 80


def analyze(latest: str, history: list[str]) -> LLMFraudAnalysis:
    completion = groq_client.chat.completions.create(
        model=LLM_MODEL,
        temperature=0.1,
        max_tokens=400,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_prompt(history, latest)},
        ],
    )
    raw = completion.choices[0].message.content or "{}"
    result = _parse(raw)

    floor = _safety_floor(latest)
    if floor and result.risk_score < floor:
        result.risk_score = floor
        note = "Requests sensitive credentials or remote access"
        if note not in result.red_flags:
            result.red_flags.insert(0, note)
    return result


def _parse(raw: str) -> LLMFraudAnalysis:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("LLM returned non-JSON output: %r", raw[:200])
        return LLMFraudAnalysis()
    if not isinstance(data, dict):
        return LLMFraudAnalysis()

    return LLMFraudAnalysis(
        risk_score=_clamp_score(data.get("risk_score")),
        scam_type=_normalise_type(data.get("scam_type")),
        red_flags=_clean_flags(data.get("red_flags")),
        advice=str(data.get("advice") or "").strip()[:300],
    )


def _safety_floor(text: str) -> int:
    """Minimum risk implied by the transcript alone (0 if none)."""
    if SECRET_REQUEST.search(text) and ACTION_VERB.search(text):
        return FLOOR_SCORE
    if REMOTE_ACCESS.search(text):
        return FLOOR_SCORE
    return 0


def _clamp_score(value) -> int:
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return 0


def _normalise_type(value) -> str:
    label = str(value or "").strip()
    if label.lower() in NONE_LABELS:
        return "None"
    for known in SCAM_TYPES:
        if label.lower() == known.lower():
            return known
    return "Other Vishing"


def _clean_flags(value) -> list[str]:
    if not isinstance(value, list):
        return []
    flags: list[str] = []
    for item in value:
        text = str(item).strip()[:120]
        if text and text not in flags:
            flags.append(text)
    return flags[:4]