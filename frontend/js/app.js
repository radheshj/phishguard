/* app.js — Main application controller & API fetch logic */
(function () {
  "use strict";

  const { AudioRecorder, TTSController, UIController, THRESH } = window.PG;

  /* ---------- Configuration (override via window.PHISHGUARD_CONFIG) ---------- */
  const CFG = Object.assign(
    {
      API_BASE: "http://localhost:8000",   // FastAPI backend (uvicorn app.main:app --reload)
      ANALYZE_ENDPOINT: "/api/analyze",    // POST multipart: audio, session_id, chunk_index
      CHUNK_MS: 4000,
      REQUEST_TIMEOUT_MS: 25000,
      MAX_INFLIGHT: 2,
      ALERT_THRESHOLD: THRESH.critical,    // risk_score > 75 → critical
    },
    window.PHISHGUARD_CONFIG || {}
  );

  const $ = (id) => document.getElementById(id);
  const ui = new UIController();
  const tts = new TTSController();

  /* ---------- Alarm (alarm.mp3 with WebAudio fallback) ---------- */
  class Alarm {
    constructor(src) {
      this.enabled = true;
      this.audio = new Audio(src);
      this.audio.preload = "auto";
      this.audio.volume = 0.8;
      this._ctx = null;
    }
    play() {
      if (!this.enabled) return;
      this.audio.currentTime = 0;
      this.audio.play().catch(() => this._fallback());
    }
    stop() { this.audio.pause(); }
    _fallback() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this._ctx = this._ctx || new AC();
        const ctx = this._ctx, t0 = ctx.currentTime;
        [880, 660, 880, 660].forEach((f, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = "sine"; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t0 + i * 0.22);
          g.gain.exponentialRampToValueAtTime(0.35, t0 + i * 0.22 + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.2);
          o.connect(g).connect(ctx.destination);
          o.start(t0 + i * 0.22); o.stop(t0 + i * 0.22 + 0.21);
        });
      } catch (_) { /* audio unavailable */ }
    }
  }
  const alarm = new Alarm("assets/alarm.mp3");

  /* ---------- Session state ---------- */
  const S = {
    monitoring: false,
    demo: false,
    sessionId: null,
    startedAt: 0,
    endedAt: 0,
    risk: 0,
    peak: 0,
    scamType: "None",
    flags: [],
    transcript: [],
    events: [],
    inflight: 0,
    failures: 0,
    warnedBackend: false,
    wasCritical: false,
    timerId: null,
    demoTimers: [],
    lastSummary: null,
  };

  const HISTORY_KEY = "phishguard.history.v1";

function saveToHistory(s) {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    list.push({
      id: s.sessionId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: (s.endedAt || Date.now()) - s.startedAt,
      peak: Math.round(s.peak),
      state: UIController.stateFor(s.peak),
      scamType: s.scamType,
      flags: s.flags.length,
      mode: s.mode,
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-200)));
  } catch (_) { /* storage unavailable */ }
}

  const recorder = new AudioRecorder({
    chunkMs: CFG.CHUNK_MS,
    onChunk: (blob, i) => sendChunk(blob, i),
    onLevel: (l) => ui.setMicLevel(l),
    onError: (err) => {
      ui.toast("Microphone error: " + (err.message || err), "error");
      stopMonitoring();
    },
  });

  const newId = () => "pg-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clock = (d = new Date()) => d.toTimeString().slice(0, 8);
  const mmss = (ms) => {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  };
  const logEvent = (kind, text) => S.events.push({ kind, text, time: clock(), at: Date.now() });

  /* =========================================================
     Monitoring lifecycle
     ========================================================= */
  async function startMonitoring() {
    resetSession(true);
    S.demo = $("demoToggle").checked;
    S.sessionId = newId();
    S.startedAt = Date.now();

    if (!S.demo) {
      if (!AudioRecorder.supported) {
        ui.toast("This browser can't record audio. Switching to demo mode.", "warn");
        $("demoToggle").checked = true; S.demo = true; ui.setMode(true);
      } else {
        try {
          await recorder.start();
        } catch (err) {
          const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
          ui.toast(denied ? "Microphone permission denied. Allow access, or try Demo scenario." : "Could not start microphone: " + err.message, "error", 6000);
          return;
        }
      }
    }

    S.monitoring = true;
    ui.setMonitoring(true, S.demo);
    ui.clearSummary();
    logEvent("action", S.demo ? "Monitoring started (demo scenario)" : "Monitoring started");
    S.timerId = setInterval(() => ui.setTimer(Date.now() - S.startedAt), 500);
    ui.setTimer(0);

    if (S.demo) runDemo();
    else ui.showTyping(true);
  }

  function stopMonitoring() {
    if (!S.monitoring) return;
    S.monitoring = false;
    S.endedAt = Date.now();
    clearInterval(S.timerId);
    S.demoTimers.forEach(clearTimeout); S.demoTimers = [];
    recorder.stop();
    tts.cancel(); alarm.stop();
    ui.showTyping(false);
    ui.showBanner(false);
    ui.setMonitoring(false, S.demo);
    logEvent("action", "Monitoring stopped");
    buildSummary();
  }

  function resetSession(keepUiMode) {
    if (S.monitoring) {
      S.monitoring = false;
      clearInterval(S.timerId);
      S.demoTimers.forEach(clearTimeout); S.demoTimers = [];
      recorder.stop(); tts.cancel(); alarm.stop();
    }
    Object.assign(S, {
      sessionId: null, startedAt: 0, endedAt: 0, risk: 0, peak: 0, scamType: "None",
      flags: [], transcript: [], events: [], inflight: 0, failures: 0, warnedBackend: false,
      wasCritical: false, lastSummary: null,
    });
    tts.resetCooldown();
    ui.clearTranscript(); ui.clearFlags(); ui.setAdvice(""); ui.setScam(null);
    ui.showBanner(false); ui.setTimer(0);
    ui.setState("idle", 0, true);
    ui.setMonitoring(false);
    if (!keepUiMode) { ui.clearSummary(); }
  }

  /* =========================================================
     Backend call
     ========================================================= */
  async function sendChunk(blob, index) {
    if (!S.monitoring || S.demo) return;
    if (S.inflight >= CFG.MAX_INFLIGHT) return; // drop to stay real-time

    S.inflight++;
    ui.showTyping(true);

    const fd = new FormData();
    fd.append("audio", blob, `chunk-${index}.${AudioRecorder.extFor(blob.type)}`);
    fd.append("session_id", S.sessionId);
    fd.append("chunk_index", String(index));

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(CFG.API_BASE + CFG.ANALYZE_ENDPOINT, { method: "POST", body: fd, signal: ctrl.signal });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      S.failures = 0;
      handleAnalysis(data);
    } catch (err) {
      S.failures++;
      if (S.failures >= 3 && !S.warnedBackend) {
        S.warnedBackend = true;
        ui.toast("Backend unreachable at " + CFG.API_BASE + ". Check that uvicorn is running — or use Demo scenario.", "error", 7000);
      }
    } finally {
      clearTimeout(to);
      S.inflight--;
      if (S.inflight === 0) ui.showTyping(S.monitoring && !S.demo ? true : false);
    }
  }

  /** Normalises whatever the backend returns into our internal shape. */
  function normalise(d) {
    d = d || {};
    return {
      transcript: d.transcript ?? d.text ?? "",
      risk: Number(d.risk_score ?? d.risk ?? d.score ?? 0),
      scamType: d.scam_type ?? d.scam_archetype ?? d.category ?? "None",
      flags: d.red_flags ?? d.flags ?? d.indicators ?? [],
      advice: d.advice ?? d.recommendation ?? d.verdict ?? d.explanation ?? "",
    };
  }

  function handleAnalysis(raw) {
    const r = normalise(raw);
    if (!Number.isFinite(r.risk)) r.risk = 0;

    S.risk = r.risk;
    S.peak = Math.max(S.peak, r.risk);
    if (r.scamType && !/^none/i.test(r.scamType)) S.scamType = r.scamType;

    if (r.transcript && r.transcript.trim()) {
      S.transcript.push({ time: clock(), text: r.transcript.trim(), risk: r.risk });
      ui.addTranscript({ text: r.transcript, risk: r.risk });
    }

    const state = ui.setRisk(r.risk);
    ui.setScam(r.scamType);
    const newFlags = (Array.isArray(r.flags) ? r.flags : [String(r.flags)]).filter((f) => f && !S.flags.includes(f));
    newFlags.forEach((f) => { S.flags.push(f); logEvent(state === "critical" ? "critical" : "suspicious", "Red flag: " + f); });
    ui.addFlags(newFlags);
    ui.setAdvice(r.advice);

    // state-change events for the incident log
    const critical = r.risk > CFG.ALERT_THRESHOLD;
    if (critical && !S.wasCritical) {
      logEvent("critical", `Risk reached ${Math.round(r.risk)} — CRITICAL PHISHING DETECTED` + (r.scamType && !/^none/i.test(r.scamType) ? ` (${r.scamType})` : ""));
      ui.showBanner(true);
      alarm.play();
    } else if (!critical && S.wasCritical) {
      ui.showBanner(false);
      logEvent("suspicious", `Risk dropped to ${Math.round(r.risk)}`);
    }
    if (critical) {
      if (tts.warnHighRisk()) logEvent("action", "Voice alert spoken: high risk detected");
    }
    S.wasCritical = critical;
  }

  /* =========================================================
     Demo scenario (works without a backend)
     ========================================================= */
  const DEMO = [
    { t: 1200, risk: 6,  type: "None", text: "Hello, am I speaking with the account holder? This is Rahul calling from the customer care department." },
    { t: 5200, risk: 22, type: "None", text: "We are calling regarding your savings account. We noticed some unusual activity on your debit card this morning." },
    { t: 9200, risk: 48, type: "Bank Fraud", flags: ["Unsolicited call claiming to be from a bank"], advice: "Banks never call to ask for card details. Do not confirm anything.",
      text: "For your security, your account will be blocked within thirty minutes unless you verify your details urgently." },
    { t: 13400, risk: 71, type: "Bank Fraud", flags: ["Artificial urgency / threat of account block"],
      text: "Please stay on the line and do not tell anyone, it is a confidential bank matter. I need your card number to verify." },
    { t: 17800, risk: 93, type: "Bank Fraud", flags: ["Requests card number", "Requests OTP", "Secrecy pressure"], advice: "Hang up immediately. Never share an OTP, PIN or password. Call your bank on its official number.",
      text: "You will receive an OTP on your phone right now, read it out immediately along with your PIN so I can stop the transaction." },
    { t: 22500, risk: 96, type: "Bank Fraud", flags: ["Pressure to act immediately"],
      text: "Sir, there is no time. If you do not share the OTP right now, your money will be transferred and we cannot help you." },
  ];

  function runDemo() {
    DEMO.forEach((step) => {
      S.demoTimers.push(setTimeout(() => {
        if (!S.monitoring) return;
        ui.showTyping(false);
        handleAnalysis({ transcript: step.text, risk_score: step.risk, scam_type: step.type, red_flags: step.flags || [], advice: step.advice || "" });
        if (step !== DEMO[DEMO.length - 1]) ui.showTyping(true);
      }, step.t - 900));
    });
  }

  /* =========================================================
     Post-call incident summary
     ========================================================= */
  function buildSummary() {
    const dur = (S.endedAt || Date.now()) - S.startedAt;
    const state = UIController.stateFor(S.peak);
    const verdict =
      state === "critical" ? "CRITICAL — Likely vishing attempt. Do not engage further; report this call."
      : state === "suspicious" ? "SUSPICIOUS — Some manipulation tactics were detected. Verify the caller independently."
      : "SAFE — No significant threat indicators detected during this call.";

    S.lastSummary = {
      sessionId: S.sessionId, startedAt: S.startedAt, endedAt: S.endedAt,
      durationText: mmss(dur), peak: Math.round(S.peak), state, verdict,
      scamType: /^none$/i.test(S.scamType) ? "None detected" : S.scamType,
      flags: S.flags.slice(), transcript: S.transcript.slice(), events: S.events.slice(),
      mode: S.demo ? "Demo scenario" : "Live",
    };
    ui.renderSummary(S.lastSummary);
      if (S.endedAt - S.startedAt > 3000) saveToHistory(S.lastSummary);
  }

  function summaryText(s) {
    const line = "=".repeat(64);
    const out = [];
    out.push(line, "  PHISHGUARD — FRAUD INCIDENT REPORT", line, "");
    out.push(`Session ID     : ${s.sessionId}`);
    out.push(`Mode           : ${s.mode}`);
    out.push(`Call started   : ${new Date(s.startedAt).toLocaleString()}`);
    out.push(`Call ended     : ${new Date(s.endedAt).toLocaleString()}`);
    out.push(`Duration       : ${s.durationText}`);
    out.push(`Peak risk      : ${s.peak}/100`);
    out.push(`Scam archetype : ${s.scamType}`);
    out.push(`Verdict        : ${s.verdict}`, "");
    out.push("RED FLAGS", "-".repeat(64));
    out.push(...(s.flags.length ? s.flags.map((f, i) => `${i + 1}. ${f}`) : ["None recorded."]), "");
    out.push("EVENT TIMELINE", "-".repeat(64));
    out.push(...(s.events.length ? s.events.map((e) => `[${e.time}] ${e.text}`) : ["No events."]), "");
    out.push("FULL TRANSCRIPT", "-".repeat(64));
    out.push(...(s.transcript.length ? s.transcript.map((t) => `[${t.time}] (risk ${Math.round(t.risk)}) ${t.text}`) : ["No speech transcribed."]), "");
    out.push(line, "Report to: National Cyber Crime Helpline 1930 · cybercrime.gov.in", "Generated by PhishGuard AI", line);
    return out.join("\n");
  }

  function downloadLog() {
    if (!S.lastSummary) return;
    const blob = new Blob([summaryText(S.lastSummary)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    const stamp = new Date(S.lastSummary.startedAt).toISOString().replace(/[:T]/g, "-").slice(0, 19);
    a.href = URL.createObjectURL(blob);
    a.download = `phishguard-incident-${stamp}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    ui.toast("Incident log downloaded", "ok");
  }

  function printReport() {
    const s = S.lastSummary;
    if (!s) return;
    const e = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    $("printSheet").innerHTML =
      `<h1>PhishGuard — Fraud Incident Report</h1><small>Generated ${e(new Date().toLocaleString())}</small>` +
      `<h2>Overview</h2><table>` +
      `<tr><td>Session ID</td><td>${e(s.sessionId)}</td></tr>` +
      `<tr><td>Call started</td><td>${e(new Date(s.startedAt).toLocaleString())}</td></tr>` +
      `<tr><td>Duration</td><td>${e(s.durationText)}</td></tr>` +
      `<tr><td>Peak risk</td><td>${s.peak}/100</td></tr>` +
      `<tr><td>Scam archetype</td><td>${e(s.scamType)}</td></tr></table>` +
      `<div class="v">${e(s.verdict)}</div>` +
      `<h2>Red flags</h2><ol>${s.flags.length ? s.flags.map((f) => `<li>${e(f)}</li>`).join("") : "<li>None recorded</li>"}</ol>` +
      `<h2>Event timeline</h2><ol>${s.events.map((x) => `<li><b>${e(x.time)}</b> — ${e(x.text)}</li>`).join("")}</ol>` +
      `<h2>Transcript</h2><ol>${s.transcript.map((t) => `<li>[${e(t.time)}] ${e(t.text)}</li>`).join("") || "<li>No speech transcribed</li>"}</ol>` +
      `<h2>Where to report</h2><p>National Cyber Crime Helpline 1930 · cybercrime.gov.in</p>`;
    window.print();
  }

  /* =========================================================
     Deterrent
     ========================================================= */
  function playDeterrent() {
    if (!tts.supported) { ui.toast("Speech synthesis isn't supported in this browser.", "error"); return; }
    if (tts.speaking) { tts.cancel(); ui.setDeterrent(false); return; }
    logEvent("action", "Safe Deterrent played to caller");
    tts.playDeterrent({
      onstart: () => ui.setDeterrent(true),
      onend: () => ui.setDeterrent(false),
    });
    ui.toast("Deterrent warning playing through speaker", "info");
  }

  /* =========================================================
     Event wiring
     ========================================================= */
  $("btnMonitor").addEventListener("click", () => (S.monitoring ? stopMonitoring() : startMonitoring()));
  $("btnDeterrent").addEventListener("click", playDeterrent);
  $("btnReset").addEventListener("click", () => { resetSession(false); ui.toast("Session cleared", "info", 2200); });
  $("btnDownload").addEventListener("click", downloadLog);
  $("btnPrint").addEventListener("click", printReport);
  $("bannerDismiss").addEventListener("click", () => ui.showBanner(false));

  $("voiceToggle").addEventListener("change", (e) => {
    tts.enabled = e.target.checked;
    if (!tts.enabled) tts.cancel();
  });
  $("alarmToggle").addEventListener("change", (e) => { alarm.enabled = e.target.checked; if (!alarm.enabled) alarm.stop(); });
  $("demoToggle").addEventListener("change", (e) => {
    if (S.monitoring) { e.target.checked = !e.target.checked; ui.toast("Stop monitoring before changing mode.", "warn"); return; }
    ui.setMode(e.target.checked);
  });

  // Keyboard shortcut: Space toggles monitoring (when not typing in a control)
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) { e.preventDefault(); $("btnMonitor").click(); }
  });

  window.addEventListener("beforeunload", () => { recorder.stop(); tts.cancel(); });

  // Initial UI
  ui.setMode(false);
  ui.setState("idle", 0, true);
  ui.setScam(null);
  if (location.protocol === "file:") {
    setTimeout(() => ui.toast("Tip: serve over http://localhost for microphone access (e.g. python -m http.server 5500).", "info", 7000), 1200);
  }
})();

document.getElementById("navToggle")?.addEventListener("click", () => {
  document.getElementById("navLinks").classList.toggle("open");
});