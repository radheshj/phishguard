"""FastAPI entrypoint for PhishGuard. """
import logging

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import ALLOWED_ORIGINS, LLM_MODEL, MAX_AUDIO_BYTES, STT_MODEL
from app.schemas import AnalyzeResponse, HealthResponse
from app.services import llm_service, stt_service
from app.services.session_store import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("phishguard")

app = FastAPI(title="PhishGuard API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _build(session_id, chunk_index, transcript, state, skipped=False) -> AnalyzeResponse:
    return AnalyzeResponse(
        session_id=session_id,
        chunk_index=chunk_index,
        transcript=transcript,
        risk_score=state["risk"],
        scam_type=state["scam_type"],
        red_flags=state["flags"],
        advice=state.get("advice", ""),
        skipped=skipped,
    )


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", stt_model=STT_MODEL, llm_model=LLM_MODEL)


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze(
    audio: UploadFile = File(...),
    session_id: str = Form(...),
    chunk_index: int = Form(0),
) -> AnalyzeResponse:
    session_id = session_id.strip()
    if not session_id or len(session_id) > 100:
        raise HTTPException(status_code=400, detail="Invalid session_id")

    data = audio.file.read(MAX_AUDIO_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio chunk")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio chunk too large")

    # 1) Speech -> text (Groq Whisper)
    try:
        transcript = stt_service.transcribe(data, audio.filename or f"chunk-{chunk_index}.webm")
    except Exception as exc:
        log.exception("Transcription failed (session %s)", session_id)
        raise HTTPException(status_code=502, detail=f"Speech-to-text failed: {type(exc).__name__}")

    # 2) Silence / noise: return current session state, don't call the LLM
    if not transcript:
        return _build(session_id, chunk_index, "", store.current(session_id), skipped=True)

    # 3) Fraud analysis (Groq Llama 3.3) using rolling call context
    try:
        analysis = llm_service.analyze(transcript, store.history(session_id))
    except Exception as exc:
        log.exception("Fraud analysis failed (session %s)", session_id)
        raise HTTPException(status_code=502, detail=f"Fraud analysis failed: {type(exc).__name__}")

    state = store.record(session_id, transcript, analysis)
    return _build(session_id, chunk_index, transcript, state)