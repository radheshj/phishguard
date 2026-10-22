/* tts.js — Web Speech API (speechSynthesis) controller */
(function () {
  "use strict";

  const DETERRENT_SCRIPT =
    "Warning: This call is monitored and recorded by PhishGuard AI. " +
    "All details are being logged for fraud reporting.";
  const HIGH_RISK_SCRIPT =
    "High risk detected. Do not share any OTP or bank passwords.";

  class TTSController {
    constructor() {
      this.supported = "speechSynthesis" in window;
      this.enabled = true;          // vocal alerts toggle
      this.cooldownMs = 15000;      // minimum gap between automatic alerts
      this.voice = null;
      this._lastAlert = 0;
      this.speaking = false;

      if (this.supported) {
        this._pickVoice();
        window.speechSynthesis.onvoiceschanged = () => this._pickVoice();
      }
    }

    _pickVoice() {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      this.voice =
        voices.find((v) => /en[-_]IN/i.test(v.lang)) ||
        voices.find((v) => /en[-_](US|GB)/i.test(v.lang) && /female|google|natural|samantha|zira/i.test(v.name)) ||
        voices.find((v) => /^en/i.test(v.lang)) ||
        voices[0];
    }

    /** Low-level speak helper. Returns a Promise that resolves when finished. */
    speak(text, { rate = 1, pitch = 1, volume = 1, interrupt = false, onstart, onend } = {}) {
      return new Promise((resolve) => {
        if (!this.supported) { resolve(false); return; }
        const synth = window.speechSynthesis;
        if (interrupt) synth.cancel();

        const u = new SpeechSynthesisUtterance(text);
        if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }
        u.rate = rate; u.pitch = pitch; u.volume = volume;
        u.onstart = () => { this.speaking = true; onstart && onstart(); };
        u.onend = u.onerror = () => { this.speaking = false; onend && onend(); resolve(true); };
        synth.speak(u);
      });
    }

    /** Automatic spoken warning when risk_score > 75. Respects toggle + cooldown. */
    warnHighRisk(force = false) {
      if (!this.supported) return false;
      if (!force && !this.enabled) return false;
      const now = Date.now();
      if (!force && now - this._lastAlert < this.cooldownMs) return false;
      this._lastAlert = now;
      this.speak(HIGH_RISK_SCRIPT, { rate: 0.95, pitch: 0.95, interrupt: true });
      return true;
    }

    /** One-tap deterrent — always plays, regardless of the alert toggle. */
    playDeterrent({ onstart, onend } = {}) {
      return this.speak(DETERRENT_SCRIPT, {
        rate: 0.9, pitch: 0.85, volume: 1, interrupt: true, onstart, onend,
      });
    }

    cancel() {
      if (this.supported) window.speechSynthesis.cancel();
      this.speaking = false;
    }

    resetCooldown() { this._lastAlert = 0; }
  }

  window.PG = window.PG || {};
  window.PG.TTSController = TTSController;
  window.PG.DETERRENT_SCRIPT = DETERRENT_SCRIPT;
})();