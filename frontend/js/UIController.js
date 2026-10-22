/* UIController.js — Threat gauge, badges & transcript updater */
(function () {
  "use strict";

  const CIRC = 2 * Math.PI * 92; // gauge circumference (r = 92)
  const THRESH = { suspicious: 35, critical: 75 };

  const ICONS = {
    safe: "assets/icons/icon-safe.svg",
    suspicious: "assets/icons/icon-suspicious.svg",
    critical: "assets/icons/icon-critical.svg",
    idle: "assets/icons/icon-shield.svg",
  };

  const CAPTIONS = {
    idle: "Start monitoring to analyse your call.",
    safe: "No threat detected — conversation looks safe.",
    suspicious: "Suspicious behaviour detected — stay alert.",
    critical: "CRITICAL PHISHING DETECTED",
  };
  const LABELS = { idle: "STANDBY", safe: "SAFE", suspicious: "SUSPICIOUS", critical: "CRITICAL" };

  // Words highlighted inside the transcript
  const KEYWORDS = [
    "otp", "one[- ]time password", "password", "pin", "cvv", "card number", "account number", "bank", "verify",
    "verification", "urgent", "immediately", "right now", "suspended", "blocked", "arrest", "warrant", "police",
    "legal action", "gift card", "wire transfer", "transfer", "remote access", "anydesk", "teamviewer", "refund",
    "kyc", "aadhaar", "pan card", "social security", "irs", "customs", "electricity", "disconnected", "penalty",
    "lottery", "prize", "do not tell", "don't tell", "stay on the line", "click the link",
  ];
  const KW_RE = new RegExp("\\b(" + KEYWORDS.join("|") + ")\\b", "gi");

  const SCAM_ICON = [
    [/bank|card|upi|account|credit|loan|kyc/i, "i-bank"],
    [/utility|electric|bill|power|gas|water|telecom|sim/i, "i-bolt"],
    [/tech|support|microsoft|remote|computer|virus|software/i, "i-monitor"],
    [/gov|agency|tax|irs|police|customs|court|arrest|legal|cbi|aadhaar|social/i, "i-gov"],
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");

  class UIController {
    constructor() {
      this.el = {
        body: document.body,
        statusPill: $("statusPill"), statusText: $("statusText"), timer: $("sessionTimer"),
        modeChip: $("modeChip"), modeText: $("modeText"),
        arc: $("gaugeArc"), score: $("gaugeScore"), label: $("gaugeLabel"), icon: $("gaugeStatusIcon"),
        caption: $("riskCaption"), marker: $("scaleMarker"),
        badge: $("scamBadge"), badgeText: $("scamBadgeText"), badgeSub: $("scamBadgeSub"), badgeIcon: $("scamBadgeIcon"),
        flags: $("flagList"), advice: $("adviceBox"), adviceText: $("adviceText"),
        btnMonitor: $("btnMonitor"), btnDeterrent: $("btnDeterrent"),
        feed: $("transcriptFeed"), empty: $("transcriptEmpty"), words: $("wordCount"), live: $("liveBadge"),
        canvas: $("waveCanvas"), micLabel: $("micLabel"),
        banner: $("criticalBanner"),
        sumEmpty: $("sumEmpty"), sumBody: $("sumBody"), sumDuration: $("sumDuration"), sumPeak: $("sumPeak"),
        sumType: $("sumType"), sumFlags: $("sumFlags"), sumVerdict: $("sumVerdict"), sumTimeline: $("sumTimeline"),
        btnDownload: $("btnDownload"), btnPrint: $("btnPrint"),
        toasts: $("toasts"),
      };

      this.el.arc.style.strokeDasharray = CIRC;
      this.el.arc.style.strokeDashoffset = CIRC;

      this._score = 0;
      this._scoreRaf = null;
      this._wordTotal = 0;
      this._flagSet = new Set();
      this._typingEl = null;

      // waveform
      this._level = 0;
      this._levels = new Array(64).fill(0);
      this._monitoring = false;
      this._wavePhase = 0;
      this._initWave();
    }

    /* ---------- state helpers ---------- */
    static stateFor(score) {
      if (score > THRESH.critical) return "critical";
      if (score >= THRESH.suspicious) return "suspicious";
      return "safe";
    }

    setMonitoring(on, demo = false) {
      this._monitoring = on;
      const e = this.el;
      e.statusPill.classList.toggle("is-live", on);
      e.statusText.textContent = on ? (demo ? "Demo running" : "Listening") : "Standby";
      e.live.classList.toggle("on", on);
      e.micLabel.textContent = on ? (demo ? "Simulated audio" : "Listening to speakerphone…") : "Microphone idle";

      e.btnMonitor.classList.toggle("is-active", on);
      e.btnMonitor.innerHTML = on
        ? '<svg class="ic"><use href="#i-stop"/></svg><span>Stop Monitoring</span>'
        : '<svg class="ic"><use href="#i-mic"/></svg><span>Start Monitoring</span>';

      if (on) this.setState("safe", 0, true);
      else if (this._score === 0) this.setState("idle", 0, true);
    }

    setMode(demo) {
      this.el.modeChip.classList.toggle("is-demo", demo);
      this.el.modeText.textContent = demo ? "Demo mode" : "Live mode";
    }

    setState(state, score, instant = false) {
      const e = this.el;
      e.body.dataset.state = state;
      e.label.textContent = LABELS[state];
      e.caption.textContent = CAPTIONS[state];
      e.icon.src = ICONS[state];
      this._animateScore(score, instant);
      const pct = Math.max(0, Math.min(100, score));
      e.arc.style.strokeDashoffset = CIRC * (1 - pct / 100);
      e.marker.style.left = pct + "%";
    }

    /** Update the gauge from a 0–100 risk score. Returns the resulting state. */
    setRisk(score) {
      score = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
      const state = UIController.stateFor(score);
      this.setState(state, score);
      this._lastState = state;
      return state;
    }

    _animateScore(target, instant) {
      cancelAnimationFrame(this._scoreRaf);
      const el = this.el.score;
      if (instant) { this._score = target; el.textContent = target; return; }
      const from = this._score, t0 = performance.now(), dur = 900;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (target - from) * eased);
        if (p < 1) this._scoreRaf = requestAnimationFrame(step);
        else this._score = target;
      };
      this._scoreRaf = requestAnimationFrame(step);
    }

    setTimer(ms) {
      const s = Math.floor(ms / 1000);
      this.el.timer.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }

    /* ---------- scam badge, flags, advice ---------- */
    setScam(type) {
      const e = this.el;
      const none = !type || /^(none|unknown|n\/a|safe|no scam)/i.test(type);
      const prev = e.badgeText.textContent;
      e.badge.classList.toggle("is-none", none);
      if (none) {
        e.badgeText.textContent = "No scam pattern detected";
        e.badgeSub.textContent = this._monitoring ? "Analysing conversation…" : "Waiting for conversation…";
        e.badgeIcon.innerHTML = '<use href="#i-shield-check"/>';
        return;
      }
      e.badgeText.textContent = type;
      e.badgeSub.textContent = "Scam style identified by AI";
      const hit = SCAM_ICON.find(([re]) => re.test(type));
      e.badgeIcon.innerHTML = `<use href="#${hit ? hit[1] : "i-alert"}"/>`;
      if (prev !== type) {
        e.badge.classList.remove("pop"); void e.badge.offsetWidth; e.badge.classList.add("pop");
      }
    }

    addFlags(list) {
      if (!Array.isArray(list)) return;
      const e = this.el;
      list.forEach((f) => {
        const text = String(f).trim();
        const key = text.toLowerCase();
        if (!text || this._flagSet.has(key)) return;
        if (!this._flagSet.size) e.flags.innerHTML = "";
        this._flagSet.add(key);
        const li = document.createElement("li");
        li.innerHTML = `<svg class="ic"><use href="#i-flag"/></svg><span>${esc(text)}</span>`;
        e.flags.appendChild(li);
      });
    }

    clearFlags() {
      this._flagSet.clear();
      this.el.flags.innerHTML = '<li class="flag-empty">None detected yet</li>';
    }

    setAdvice(text) {
      const e = this.el;
      if (!text) { e.advice.hidden = true; return; }
      e.adviceText.textContent = text;
      e.advice.hidden = false;
    }

    showBanner(show) { this.el.banner.hidden = !show; }

    /* ---------- transcript ---------- */
    highlight(text) {
      return esc(text).replace(KW_RE, "<mark>$1</mark>");
    }

    showTyping(on) {
      const e = this.el;
      if (on && !this._typingEl) {
        e.empty.hidden = true;
        const d = document.createElement("div");
        d.className = "msg";
        d.innerHTML = '<div class="msg-avatar"><svg class="ic"><use href="#i-phone"/></svg></div><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div>';
        e.feed.appendChild(d);
        this._typingEl = d;
        this._scroll();
      } else if (!on && this._typingEl) {
        this._typingEl.remove();
        this._typingEl = null;
      }
    }

    addTranscript({ text, risk = 0, time = new Date() }) {
      if (!text || !text.trim()) return;
      const e = this.el;
      this.showTyping(false);
      e.empty.hidden = true;

      const state = UIController.stateFor(risk);
      const cls = state === "critical" ? "crit" : state === "suspicious" ? "warn" : "";
      const t = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
      const div = document.createElement("div");
      div.className = `msg ${cls}`;
      div.innerHTML =
        `<div class="msg-avatar"><svg class="ic"><use href="#i-phone"/></svg></div>` +
        `<div class="msg-body"><div class="msg-meta"><span>Caller · ${t}</span>` +
        `<span class="risk-chip ${state}">RISK ${Math.round(risk)}</span></div>` +
        `<div class="msg-text">${this.highlight(text.trim())}</div></div>`;
      e.feed.appendChild(div);

      this._wordTotal += text.trim().split(/\s+/).length;
      e.words.textContent = `${this._wordTotal} words`;
      this._scroll();
    }

    clearTranscript() {
      const e = this.el;
      [...e.feed.querySelectorAll(".msg")].forEach((n) => n.remove());
      this._typingEl = null;
      this._wordTotal = 0;
      e.words.textContent = "0 words";
      e.empty.hidden = false;
    }

    _scroll() { this.el.feed.scrollTop = this.el.feed.scrollHeight; }

    /* ---------- deterrent button ---------- */
    setDeterrent(active) {
      this.el.btnDeterrent.classList.toggle("is-speaking", active);
      this.el.btnDeterrent.querySelector("span:last-child").textContent = active ? "Speaking warning…" : "Play Safe Deterrent";
    }

    /* ---------- summary ---------- */
    renderSummary(sum) {
      const e = this.el;
      e.sumEmpty.hidden = true;
      e.sumBody.hidden = false;
      e.sumDuration.textContent = sum.durationText;
      e.sumPeak.textContent = `${sum.peak}/100`;
      e.sumType.textContent = sum.scamType;
      e.sumFlags.textContent = sum.flags.length;
      e.sumVerdict.className = `verdict ${sum.state}`;
      e.sumVerdict.innerHTML = `<svg class="ic"><use href="#${sum.state === "safe" ? "i-shield-check" : "i-alert"}"/></svg><span>${esc(sum.verdict)}</span>`;
      e.sumTimeline.innerHTML = sum.events.length
        ? sum.events.map((ev) =>
            `<li class="${ev.kind}"><time>${esc(ev.time)}</time>${esc(ev.text)}</li>`).join("")
        : '<li>No events recorded.</li>';
      e.btnDownload.disabled = false;
      e.btnPrint.disabled = false;
      e.sumBody.closest(".card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    clearSummary() {
      const e = this.el;
      e.sumEmpty.hidden = false;
      e.sumBody.hidden = true;
      e.btnDownload.disabled = true;
      e.btnPrint.disabled = true;
    }

    /* ---------- toast ---------- */
    toast(message, kind = "info", ms = 4200) {
      const icon = { info: "i-shield", ok: "i-check", warn: "i-alert", error: "i-alert" }[kind] || "i-shield";
      const t = document.createElement("div");
      t.className = `toast ${kind}`;
      t.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span>${esc(message)}</span>`;
      this.el.toasts.appendChild(t);
      setTimeout(() => {
        t.classList.add("out");
        setTimeout(() => t.remove(), 350);
      }, ms);
    }

    /* ---------- waveform ---------- */
    setMicLevel(level) { this._level = level; }

    _initWave() {
      const c = this.el.canvas;
      const ctx = c.getContext("2d");
      const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        const r = c.getBoundingClientRect();
        c.width = Math.max(1, r.width * dpr);
        c.height = Math.max(1, r.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      resize();
      window.addEventListener("resize", resize);

      const cssRgb = () => getComputedStyle(document.body).getPropertyValue("--sc-rgb").trim() || "100,116,139";

      const draw = () => {
        const r = c.getBoundingClientRect();
        const w = r.width, h = r.height;
        ctx.clearRect(0, 0, w, h);

        this._wavePhase += 0.04;
        // push a new level sample (smoothed); idle shows a gentle breathing line
        const target = this._monitoring ? this._level : 0.04 + 0.03 * Math.sin(this._wavePhase);
        const last = this._levels[this._levels.length - 1];
        this._levels.push(last + (target - last) * 0.35);
        this._levels.shift();

        const rgb = cssRgb();
        const n = this._levels.length;
        const gap = 4, barW = Math.max(2, w / n - gap);
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, `rgba(${rgb},0.25)`);
        grad.addColorStop(1, `rgba(${rgb},0.95)`);
        ctx.fillStyle = grad;

        for (let i = 0; i < n; i++) {
          const wobble = 0.65 + 0.35 * Math.sin(i * 0.7 + this._wavePhase * 2);
          const bh = Math.max(3, this._levels[i] * h * 0.9 * wobble + 3);
          const x = i * (w / n) + gap / 2;
          const y = (h - bh) / 2;
          const rad = barW / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, rad); else ctx.rect(x, y, barW, bh);
          ctx.fill();
        }
        requestAnimationFrame(draw);
      };
      draw();
    }
  }

  window.PG = window.PG || {};
  window.PG.UIController = UIController;
  window.PG.THRESH = THRESH;
})();