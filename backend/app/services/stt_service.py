"""Speech-to-text using Groq's hosted Whisper model."""
import re

from app.config import STT_MODEL, groq_client

MIN_CHARS = 3

# Whisper often hallucinates these phrases on silence or background noise.
HALLUCINATIONS = {
    "you",
    "thank you.",
    "thanks for watching.",
    "thank you for watching.",
    "bye.",
    "silence.",
    "subtitles by the amara.org community",
}


def transcribe(audio: bytes, filename: str) -> str:
    """Return cleaned transcript text, or '' if the chunk has no real speech."""
    response = groq_client.audio.transcriptions.create(
        file=(filename, audio),
        model=STT_MODEL,
        response_format="json",
        temperature=0.0,
    )
    text = re.sub(r"\s+", " ", (getattr(response, "text", "") or "")).strip()
    normalised = text.lower()
    if len(normalised) < MIN_CHARS or normalised in HALLUCINATIONS:
        return ""
    return text