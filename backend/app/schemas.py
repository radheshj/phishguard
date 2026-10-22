"""Pydantic schemas for API responses and structured LLM output."""
from typing import List

from pydantic import BaseModel, Field

SCAM_TYPES = (
    "None",
    "Bank Fraud",
    "Urgent Utility Bill",
    "Tech Support Impersonation",
    "Government Agency Threat",
    "Other Vishing",
)


class LLMFraudAnalysis(BaseModel):
    """Result of one analysis step (already clamped and normalised by llm_service)."""
    risk_score: int = 0
    scam_type: str = "None"
    red_flags: List[str] = Field(default_factory=list)
    advice: str = ""


class AnalyzeResponse(BaseModel):
    """What the frontend receives for every audio chunk."""
    session_id: str
    chunk_index: int
    transcript: str
    risk_score: int = Field(ge=0, le=100)
    scam_type: str
    red_flags: List[str]
    advice: str
    skipped: bool = False  # True when the chunk contained no usable speech


class HealthResponse(BaseModel):
    status: str
    stt_model: str
    llm_model: str