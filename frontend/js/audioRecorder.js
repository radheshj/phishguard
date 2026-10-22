/* audioRecorder.js — MediaRecorder chunking logic */
(function () {
  "use strict";

  class AudioRecorder {
    /**
     * @param {Object}   opts
     * @param {number}   opts.chunkMs           length of each chunk (ms)
     * @param {number}   opts.silenceThreshold  0–1 RMS below which a chunk is skipped
     * @param {Function} opts.onChunk(blob, i)  called with every usable chunk
     * @param {Function} opts.onLevel(level)    0–1 live mic level (for the waveform)
     * @param {Function} opts.onError(err)
     */
    constructor(opts = {}) {
      this.chunkMs = opts.chunkMs || 4000;
      this.silenceThreshold = opts.silenceThreshold ?? 0.012;
      this.onChunk = opts.onChunk || (() => {});
      this.onLevel = opts.onLevel || (() => {});
      this.onError = opts.onError || (() => {});

      this.stream = null;
      this.recorder = null;
      this.running = false;
      this.seq = 0;

      this._timer = null;
      this._raf = null;
      this._ctx = null;
      this._analyser = null;
      this._buf = null;
      this._peak = 0;
      this.mimeType = AudioRecorder.pickMime();
    }

    static pickMime() {
      if (!window.MediaRecorder) return "";
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    }

    static extFor(mime) {
      if (!mime) return "webm";
      if (mime.includes("mp4")) return "m4a";
      if (mime.includes("ogg")) return "ogg";
      return "webm";
    }

    static get supported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    }

    async start() {
      if (!AudioRecorder.supported) {
        throw new Error("Microphone recording is not supported in this browser.");
      }
      if (this.running) return;

      // Raw, un-processed audio is best for picking up a distant speakerphone.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      this._setupAnalyser();
      this.running = true;
      this.seq = 0;
      this._cycle();
      this._meter();
    }

    stop() {
      this.running = false;
      clearTimeout(this._timer);
      cancelAnimationFrame(this._raf);

      // Stopping the active recorder flushes the final partial chunk via onstop.
      if (this.recorder && this.recorder.state !== "inactive") {
        try { this.recorder.stop(); } catch (_) { /* noop */ }
      } else {
        this._release();
      }
      this.onLevel(0);
    }

    /* ---------- internals ---------- */

    _setupAnalyser() {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AC();
      const src = this._ctx.createMediaStreamSource(this.stream);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 1024;
      this._analyser.smoothingTimeConstant = 0.6;
      this._buf = new Uint8Array(this._analyser.fftSize);
      src.connect(this._analyser);
    }

    _meter() {
      const tick = () => {
        if (!this.running || !this._analyser) return;
        this._analyser.getByteTimeDomainData(this._buf);
        let sum = 0;
        for (let i = 0; i < this._buf.length; i++) {
          const v = (this._buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this._buf.length);
        this._peak = Math.max(this._peak, rms);
        this.onLevel(Math.min(1, rms * 4));
        this._raf = requestAnimationFrame(tick);
      };
      tick();
    }

    _cycle() {
      if (!this.running || !this.stream) return;

      const chunks = [];
      this._peak = 0;
      let rec;
      try {
        rec = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
      } catch (err) {
        this.running = false;
        this.onError(err);
        return;
      }
      this.recorder = rec;

      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = (e) => this.onError(e.error || new Error("Recorder error"));
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || this.mimeType || "audio/webm" });
        const audible = this._peak >= this.silenceThreshold;
        if (blob.size > 1500 && audible) {
          this.onChunk(blob, this.seq++);
        }
        if (this.running) this._cycle();
        else this._release();
      };

      rec.start();
      this._timer = setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, this.chunkMs);
    }

    _release() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (this._ctx) { this._ctx.close().catch(() => {}); this._ctx = null; }
      this._analyser = null;
      this.recorder = null;
    }
  }

  window.PG = window.PG || {};
  window.PG.AudioRecorder = AudioRecorder;
})();