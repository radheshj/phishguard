"""In-memory per-call state (rolling context, risk, flags)"""

import threading
import time
from collections import deque
from dataclasses import dataclass, field

from app.config import HISTORY_TURNS, SESSION_TTL_SECONDS
from app.schemas import LLMFraudAnalysis

MAX_FLAGS = 20
RISK_DECAY = 0.85  # risk eases off gradually so a critical alert doesn't flicker


@dataclass
class _Session:
    history: deque = field(default_factory=lambda: deque(maxlen=HISTORY_TURNS))
    risk: float = 0.0
    scam_type: str = "None"
    flags: list = field(default_factory=list)
    touched: float = field(default_factory=time.time)


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, _Session] = {}

    def history(self, session_id: str) -> list[str]:
        with self._lock:
            s = self._sessions.get(session_id)
            return list(s.history) if s else []

    def current(self, session_id: str) -> dict:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None:
                return {"risk": 0, "scam_type": "None", "flags": [], "advice": ""}
            return {"risk": round(s.risk), "scam_type": s.scam_type, "flags": list(s.flags), "advice": ""}

    def record(self, session_id: str, transcript: str, analysis: LLMFraudAnalysis) -> dict:
        with self._lock:
            self._evict_locked()
            s = self._sessions.setdefault(session_id, _Session())
            s.touched = time.time()
            s.history.append(transcript)
            s.risk = max(float(analysis.risk_score), s.risk * RISK_DECAY)
            if analysis.scam_type != "None":
                s.scam_type = analysis.scam_type
            for flag in analysis.red_flags:
                if flag not in s.flags and len(s.flags) < MAX_FLAGS:
                    s.flags.append(flag)
            return {
                "risk": round(s.risk),
                "scam_type": s.scam_type,
                "flags": list(s.flags),
                "advice": analysis.advice,
            }

    def _evict_locked(self) -> None:
        cutoff = time.time() - SESSION_TTL_SECONDS
        for sid in [k for k, v in self._sessions.items() if v.touched < cutoff]:
            del self._sessions[sid]


store = SessionStore()