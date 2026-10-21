/* ============================================================
   语音引擎：浏览器原生 ASR/TTS + 可插拔云端 ASR/TTS
   ============================================================ */
(function () {
  "use strict";

  function rmsFrom(analyser, buffer) {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = (buffer[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buffer.length);
  }

  function chunkText(text, maxLen) {
    maxLen = maxLen || 170;
    const parts = String(text).match(/[^.!?。！？\n]+[.!?。！？]?/g) || [String(text)];
    const chunks = [];
    let buf = "";
    parts.forEach((p) => {
      const piece = p.trim();
      if (!piece) return;
      if ((buf + " " + piece).trim().length > maxLen && buf) {
        chunks.push(buf.trim());
        buf = piece;
      } else {
        buf = (buf ? buf + " " : "") + piece;
      }
    });
    if (buf.trim()) chunks.push(buf.trim());
    return chunks.length ? chunks : [String(text)];
  }

  class SpeechEngine {
    constructor() {
      this.audioCtx = null;
      this.playbackAnalyser = null;
      this.playbackBuf = null;
      this.micStream = null;
      this.micAnalyser = null;
      this.micBuf = null;
      this.micLevel = 0;
      this.micRaf = null;

      this.recognition = null;
      this.recorder = null;
      this.recorderChunks = [];
      this.vadTimer = null;
      this.recording = false;

      this.speaking = false;
      this.cancelled = false;
      this.audioEl = null;
      this.currentUrl = null;
      this.currentResolve = null;

      this.voices = [];
      this.loadVoices();
      if (window.speechSynthesis) {
        window.speechSynthesis.addEventListener("voiceschanged", () => this.loadVoices());
      }
      setTimeout(() => this.loadVoices(), 400);
    }

    // ---------------- 通用 ----------------
    ensureAudio() {
      if (!this.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.audioCtx = new AC();
      }
      if (this.audioCtx && this.audioCtx.state === "suspended") {
        this.audioCtx.resume().catch(() => {});
      }
      return this.audioCtx;
    }

    loadVoices() {
      try {
        this.voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      } catch (e) {
        this.voices = [];
      }
      if (this.voices.length && this.onVoices) this.onVoices(this.voices);
    }

    getVoices() {
      return this.voices || [];
    }

    pickVoice(lang, preferred) {
      const list = this.getVoices();
      if (!list.length) return null;
      const target = (lang || "en-US").toLowerCase();
      const prefix = target.split("-")[0];
      const pref = (preferred || "").toLowerCase();
      let best = null;
      let bestScore = -99;
      list.forEach((v) => {
        const name = (v.name || "").toLowerCase();
        const vlang = (v.lang || "").toLowerCase();
        let score = 0;
        if (vlang === target) score += 6;
        else if (vlang.split("-")[0] === prefix) score += 3;
        else score -= 4;
        if (pref && (name === pref || v.name === preferred)) score += 8;
        else if (pref && name.indexOf(pref) >= 0) score += 5;
        if (name.indexOf("natural") >= 0) score += 3;
        if (name.indexOf("google") >= 0) score += 2;
        if (name.indexOf("aria") >= 0 || name.indexOf("jenny") >= 0 || name.indexOf("samantha") >= 0) score += 2;
        if (name.indexOf("desktop") >= 0) score -= 2;
        if (score > bestScore) { bestScore = score; best = v; }
      });
      return best;
    }

    getPlaybackLevel() {
      if (!this.playbackAnalyser) return 0;
      if (!this.playbackBuf || this.playbackBuf.length !== this.playbackAnalyser.fftSize) {
        this.playbackBuf = new Uint8Array(this.playbackAnalyser.fftSize);
      }
      return Math.min(1, rmsFrom(this.playbackAnalyser, this.playbackBuf) * 4.2);
    }

    getMicLevel() {
      return this.micLevel;
    }

    // ---------------- 麦克风电平 ----------------
    async ensureMicStream() {
      if (this.micStream && this.micStream.active) return this.micStream;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("当前环境不支持麦克风访问");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.micStream = stream;
      this.attachMicAnalyser(stream);
      return stream;
    }

    attachMicAnalyser(stream) {
      const ctx = this.ensureAudio();
      if (!ctx) return;
      try {
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        this.micAnalyser = analyser;
        this.micBuf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (!this.micAnalyser) return;
          this.micLevel = Math.min(1, rmsFrom(this.micAnalyser, this.micBuf) * 5);
          this.micRaf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        // 电平可视化失败不影响录音
      }
    }

    releaseMic() {
      if (this.micRaf) cancelAnimationFrame(this.micRaf);
      this.micRaf = null;
      this.micAnalyser = null;
      this.micLevel = 0;
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }
    }

    // ---------------- TTS ----------------
    stopSpeaking() {
      this.cancelled = true;
      this.speaking = false;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (this.audioEl) {
        try { this.audioEl.pause(); } catch (e) {}
        this.audioEl = null;
      }
      if (this.currentResolve) {
        const resolve = this.currentResolve;
        this.currentResolve = null;
        resolve();
      }
      if (this.currentUrl) {
        URL.revokeObjectURL(this.currentUrl);
        this.currentUrl = null;
      }
      this.playbackAnalyser = null;
    }

    async speak(text, opts) {
      opts = opts || {};
      text = (text || "").trim();
      if (!text) return;
      this.stopSpeaking();
      this.cancelled = false;
      this.speaking = true;

      if (opts.mode === "api") {
        try {
          await this.speakCloud(text, opts);
          return;
        } catch (err) {
          if (opts.onFallback) opts.onFallback(err);
          if (this.cancelled) return;
        }
      }
      await this.speakBrowser(text, opts);
    }

    async speakCloud(text, opts) {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: opts.voice }),
      });
      if (!res.ok) {
        let msg = "云端语音合成失败";
        try { const data = await res.json(); msg = (data.error && data.error.message) || msg; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (this.cancelled) return;
      const url = URL.createObjectURL(blob);
      this.currentUrl = url;
      const audio = new Audio(url);
      audio.preload = "auto";
      this.audioEl = audio;

      const ctx = this.ensureAudio();
      if (ctx) {
        try {
          const src = ctx.createMediaElementSource(audio);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          src.connect(analyser);
          analyser.connect(ctx.destination);
          this.playbackAnalyser = analyser;
        } catch (e) {
          this.playbackAnalyser = null;
        }
      }

      if (opts.onStart) opts.onStart();
      await new Promise((resolve, reject) => {
        this.currentResolve = resolve;
        audio.onended = () => { this.currentResolve = null; resolve(); };
        audio.onerror = () => { this.currentResolve = null; reject(new Error("音频播放失败")); };
        audio.play().catch((err) => {
          this.currentResolve = null;
          reject(err);
        });
      });
      if (this.currentUrl) {
        URL.revokeObjectURL(this.currentUrl);
        this.currentUrl = null;
      }
      this.playbackAnalyser = null;
      this.speaking = false;
      if (!this.cancelled && opts.onEnd) opts.onEnd();
    }

    async speakBrowser(text, opts) {
      const synth = window.speechSynthesis;
      if (!synth) {
        this.speaking = false;
        if (opts.onError) opts.onError(new Error("当前浏览器不支持语音合成"));
        return;
      }
      const lang = opts.lang || "en-US";
      const voice = this.pickVoice(lang, opts.voice);
      const rate = Math.max(0.5, Math.min(1.6, Number(opts.rate) || 1));
      const chunks = chunkText(text, 160);
      if (opts.onStart) opts.onStart();

      for (let i = 0; i < chunks.length; i++) {
        if (this.cancelled) break;
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(chunks[i]);
          u.lang = lang;
          u.rate = rate;
          u.pitch = 1;
          u.volume = 1;
          if (voice) u.voice = voice;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          u.onend = finish;
          u.onerror = finish;
          const timer = setTimeout(finish, Math.max(6000, chunks[i].length * 130) + 4000);
          try {
            synth.speak(u);
            if (synth.paused) synth.resume();
          } catch (e) {
            finish();
          }
        });
      }
      this.speaking = false;
      if (!this.cancelled && opts.onEnd) opts.onEnd();
    }

    // ---------------- ASR：浏览器 ----------------
    isBrowserAsrSupported() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    startBrowserListening(opts) {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) {
        if (opts.onError) opts.onError(new Error("当前浏览器不支持语音识别，请使用 Chrome / Edge，或输入文字"));
        return false;
      }
      this.stopBrowserListening();
      const rec = new Ctor();
      rec.lang = opts.lang || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      this.recognition = rec;

      let finalText = "";
      let sawError = false;

      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (opts.onPartial) opts.onPartial((finalText + " " + interim).trim());
      };

      rec.onerror = (ev) => {
        sawError = true;
        const map = {
          "not-allowed": "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问",
          "service-not-allowed": "浏览器语音服务不可用，请允许麦克风权限",
          network: "语音识别服务连接失败（可能受网络限制），可改用文字输入或在设置中配置云端 ASR",
          "no-speech": "没有听到声音，请靠近麦克风再说一次",
          "audio-capture": "没有检测到可用的麦克风设备",
          aborted: "",
        };
        const msg = map[ev.error] !== undefined ? map[ev.error] : "语音识别出错：" + ev.error;
        if (msg && opts.onError) opts.onError(new Error(msg), ev.error);
      };

      rec.onend = () => {
        this.recognition = null;
        if (opts.onEnd) opts.onEnd();
        const text = finalText.trim();
        if (text) {
          if (opts.onFinal) opts.onFinal(text);
        } else if (!sawError && opts.onError) {
          opts.onError(new Error("没有识别到内容，请再说一次"));
        }
      };

      try {
        rec.start();
        return true;
      } catch (e) {
        this.recognition = null;
        if (opts.onError) opts.onError(new Error("无法启动语音识别：" + e.message));
        return false;
      }
    }

    stopBrowserListening() {
      if (this.recognition) {
        try { this.recognition.abort(); } catch (e) {}
        this.recognition = null;
      }
    }

    // ---------------- ASR：云端 API（录音 + 静音检测） ----------------
    async startApiListening(opts) {
      let stream;
      try {
        stream = await this.ensureMicStream();
      } catch (err) {
        const hint = err && err.name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问"
          : "麦克风不可用：" + (err.message || err);
        if (opts.onError) opts.onError(new Error(hint));
        return false;
      }

      let mime = "audio/webm";
      if (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mime = "audio/webm;codecs=opus";
      } else if (window.MediaRecorder && MediaRecorder.isTypeSupported("audio/mp4")) {
        mime = "audio/mp4";
      }

      let recorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime });
      } catch (e) {
        if (opts.onError) opts.onError(new Error("录音初始化失败：" + e.message));
        return false;
      }

      this.recorder = recorder;
      this.recorderChunks = [];
      this.recording = true;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.recorderChunks.push(e.data);
      };

      recorder.onstop = async () => {
        this.recording = false;
        if (this.vadTimer) clearInterval(this.vadTimer);
        this.vadTimer = null;
        if (opts.onEnd) opts.onEnd();
        const blob = new Blob(this.recorderChunks, { type: mime });
        this.recorder = null;
        this.recorderChunks = [];
        if (blob.size < 1500) {
          if (opts.onError) opts.onError(new Error("录音太短，请完整说一句话"));
          return;
        }
        try {
          const cleanMime = mime.split(";")[0];
          const res = await fetch("/api/asr?mime=" + encodeURIComponent(cleanMime), {
            method: "POST",
            headers: { "Content-Type": cleanMime },
            body: blob,
          });
          let data = {};
          try { data = await res.json(); } catch (e) {}
          if (!res.ok) {
            const msg = (data.error && data.error.message) || "语音识别服务返回错误";
            const err = new Error(msg);
            err.code = "cloud-failed";
            throw err;
          }
          const text = (data.text || "").trim();
          if (!text) throw new Error("没有识别到内容，请再说一次");
          if (opts.onFinal) opts.onFinal(text);
        } catch (err) {
          if (opts.onError) opts.onError(err, err.code || "cloud-failed");
        }
      };

      recorder.start();
      if (opts.onStart) opts.onStart();

      const analyser = this.micAnalyser;
      const startedAt = Date.now();
      let speechAt = 0;
      let lastLoud = 0;
      const tick = () => {
        if (!this.recording) return;
        const level = analyser ? this.micLevel : 0.4;
        const now = Date.now();
        if (level > 0.06) {
          if (!speechAt) speechAt = now;
          lastLoud = now;
        }
        const tooLong = now - startedAt > 25000;
        const silenceEnd = speechAt && now - lastLoud > 1400;
        const noSpeech = !speechAt && now - startedAt > 8000;
        if (tooLong || silenceEnd || noSpeech) {
          this.stopApiListening();
        }
      };
      this.vadTimer = setInterval(tick, 100);
      return true;
    }

    stopApiListening() {
      if (this.recorder && this.recorder.state !== "inactive") {
        try { this.recorder.stop(); } catch (e) {}
      }
      if (this.vadTimer) clearInterval(this.vadTimer);
      this.vadTimer = null;
    }

    stopAll() {
      this.stopBrowserListening();
      this.stopApiListening();
      this.stopSpeaking();
      this.releaseMic();
    }
  }

  window.SpeechEngine = SpeechEngine;
})();
