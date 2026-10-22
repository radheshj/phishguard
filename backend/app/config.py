"""Environment-driven configuration and the shared Groq client."""
import os
from pathlib import Path

from dotenv import load_dotenv
from groq import Groq

# Load backend/.env (one level above the app/ package)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
STT_MODEL = os.getenv("STT_MODEL", "whisper-large-v3-turbo")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-oss-120b")

MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(5 * 1024 * 1024)))
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "3600"))
HISTORY_TURNS = int(os.getenv("HISTORY_TURNS", "8"))

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8080",
    ).split(",")
    if o.strip()
]

if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY is not set. Copy .env.example to .env and add your key.")

groq_client = Groq(api_key=GROQ_API_KEY)