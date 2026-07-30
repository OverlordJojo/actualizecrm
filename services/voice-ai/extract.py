"""
Structured extraction from a live call transcript, via local Ollama.

The prompt is deliberately hostile toward guessing. A wrong auto-written email
costs a deal, so every non-null field must carry the prospect's literal words
as evidence — if the model cannot quote it, the field is null by construction.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")

SYSTEM_PROMPT = """You extract structured facts from a live B2B cold call transcript. You output JSON only. No prose, no markdown, no code fences.

CONTEXT PROVIDED TO YOU:
- current_datetime_operator_tz: the exact current date and time in the operator's timezone
- operator_timezone: IANA timezone of the operator's calendar
- prospect_area_code: the area code of the number being dialed
- prospect_inferred_timezone: timezone derived from that area code
- lead_on_file: the currently stored first_name, last_name, email, company, address
- transcript_window: the last 8 speaker-tagged turns

ABSOLUTE RULES:
1. Extract ONLY what the PROSPECT explicitly stated. Never extract from OPERATOR turns. The operator reading an email address aloud to confirm it is NOT the prospect providing it.
2. If a fact was not explicitly stated, output null. Never infer, never complete, never guess a plausible value.
3. For every non-null field you MUST populate "evidence" with the prospect's literal words that justify it. If you cannot quote them, the field must be null.
4. Output a confidence between 0.0 and 1.0 for every non-null field. Be harsh. Audio is noisy and mistakes are expensive.
5. Only report a field as changed if it MEANINGFULLY differs from lead_on_file. Ignore casing, punctuation, and whitespace differences.

EMAIL RULES:
- Reconstruct spelled-out addresses: "j-o-s-h at gmail dot com" becomes "josh@gmail.com".
- "dot" becomes ".", "at" becomes "@", "underscore" becomes "_", "dash" and "hyphen" become "-".
- Only report an email correction if the prospect is supplying a DIFFERENT address, not confirming the existing one. "Yes that's right" is a confirmation — output null.
- Validate the result is a syntactically valid address. If not, output null.

DATETIME RULES:
- Resolve relative expressions against current_datetime_operator_tz. "Next Tuesday" means the Tuesday of the following week, not the coming Tuesday, unless the prospect clarifies.
- Determine the prospect's timezone in this priority order: (a) they explicitly state one, (b) prospect_inferred_timezone from area code, (c) operator_timezone. Report which method you used in timezone_source.
- Convert the agreed time INTO operator_timezone and output it in that zone as an ISO 8601 string with offset.
- Ambiguous AM/PM: business hours assumption only for 8-11 (AM) and 1-6 (PM). For 12 or 7, output null and set needs_clarification true.
- A time is only a booking if the prospect AGREED to it. A time the operator proposed and the prospect did not accept is not a booking.

STAGE RULES — choose exactly one:
- "booked": prospect agreed to a specific date AND time
- "interested": positive signal, wants information, asked substantive questions, but no time agreed
- "callback": asked to be contacted at a later unspecified time, or said now is bad
- "not_interested": explicit rejection, asked to be removed, or hostile
- "new": no clear signal yet
Do not report "booked" without a resolvable datetime.

OUTPUT SCHEMA — return exactly this shape:
{
  "email": {"value": string|null, "evidence": string|null, "confidence": number},
  "first_name": {"value": string|null, "evidence": string|null, "confidence": number},
  "last_name": {"value": string|null, "evidence": string|null, "confidence": number},
  "company": {"value": string|null, "evidence": string|null, "confidence": number},
  "address": {"value": string|null, "evidence": string|null, "confidence": number},
  "booking": {
    "datetime_operator_tz": string|null,
    "prospect_stated_time": string|null,
    "timezone_source": "explicit"|"area_code"|"operator_default"|null,
    "duration_minutes": number|null,
    "needs_clarification": boolean,
    "evidence": string|null,
    "confidence": number
  },
  "stage": {"value": string, "evidence": string|null, "confidence": number},
  "is_gatekeeper": boolean,
  "is_voicemail_or_automated": boolean
}"""

VERIFY_PROMPT = """You are verifying a proposed appointment extraction. Given the transcript window, the current datetime in the operator's timezone, and the proposed booking, answer:
1. Did the prospect explicitly agree to this specific date and time?
2. Is the timezone conversion arithmetic correct?
3. Is the resolved date in the future and within the next 90 days?
Output JSON only: {"verified": boolean, "reason": string, "corrected_datetime": string|null}"""


# --- cheap gate -------------------------------------------------------------
# Running a 7B model on every segment wastes compute and adds latency for no
# benefit — most turns contain nothing extractable. These heuristics decide
# whether a segment is even worth asking about.

_EMAIL_HINTS = re.compile(
    r"@|at gmail|at yahoo|at outlook|at hotmail|dot com|dot net|dot org|dot co",
    re.I,
)
_SPELLED = re.compile(r"\b(?:[a-z][\s,.-]+){3,}", re.I)
_TIME_HINTS = re.compile(
    r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|"
    r"next week|morning|afternoon|evening|noon|"
    r"january|february|march|april|may|june|july|august|september|october|"
    r"november|december|"
    r"\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2})\b",
    re.I,
)
_INTENT = re.compile(
    r"\b(not interested|remove me|take me off|call me back|reach me|send me|"
    r"sounds good|let'?s do it|no thanks|stop calling)\b",
    re.I,
)
_PHONE = re.compile(r"(?:\d[\s-]?){7,}")


def worth_extracting(text: str) -> bool:
    """True when a prospect segment plausibly contains an extractable fact."""
    return bool(
        _EMAIL_HINTS.search(text)
        or _SPELLED.search(text)
        or _TIME_HINTS.search(text)
        or _INTENT.search(text)
        or _PHONE.search(text)
    )


async def _ollama(system: str, user: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=45.0) as client:
        res = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "format": "json",
                "options": {"temperature": 0},
            },
        )
        res.raise_for_status()
        content = res.json()["message"]["content"]
        return json.loads(content)


async def extract(
    transcript_window: list[dict[str, str]],
    lead_on_file: dict[str, Any],
    operator_tz: str = "America/Vancouver",
    prospect_area_code: str | None = None,
    prospect_tz: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(ZoneInfo(operator_tz))

    payload = {
        "current_datetime_operator_tz": now.isoformat(),
        "operator_timezone": operator_tz,
        "prospect_area_code": prospect_area_code,
        "prospect_inferred_timezone": prospect_tz or operator_tz,
        "lead_on_file": lead_on_file,
        "transcript_window": transcript_window[-8:],
    }

    return await _ollama(SYSTEM_PROMPT, json.dumps(payload))


async def verify_booking(
    transcript_window: list[dict[str, str]],
    proposed_iso: str,
    operator_tz: str = "America/Vancouver",
) -> dict[str, Any]:
    """Second pass (§5.5). Booking errors are the expensive kind, so a proposal
    is only surfaced to the operator once a fresh call agrees with it."""
    now = datetime.now(ZoneInfo(operator_tz))

    payload = {
        "current_datetime_operator_tz": now.isoformat(),
        "operator_timezone": operator_tz,
        "proposed_booking": proposed_iso,
        "transcript_window": transcript_window[-8:],
    }

    result = await _ollama(VERIFY_PROMPT, json.dumps(payload))

    # Belt and braces: enforce the 90-day window in code rather than trusting
    # the model's arithmetic, which is the part it is worst at.
    candidate = result.get("corrected_datetime") or proposed_iso
    try:
        when = datetime.fromisoformat(candidate)
        if when <= now or when > now + timedelta(days=90):
            return {
                "verified": False,
                "reason": "Resolved date is in the past or beyond 90 days.",
                "corrected_datetime": None,
            }
    except (ValueError, TypeError):
        return {
            "verified": False,
            "reason": "Could not parse the resolved datetime.",
            "corrected_datetime": None,
        }

    return result
