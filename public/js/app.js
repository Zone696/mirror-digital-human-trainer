/* ============================================================
   镜界 MIRROR · 主应用逻辑
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    config: null,
    scenarios: [],
    scenario: null,
    session: null,
    busy: false,
    listening: false,
    speaking: false,
    readOnly: false,
    asrModeUsed: "browser",
    asrCloudFailed: false,
    lastAssistantText: "",
    replayRecord: null,
    voiceList: [],
    clockTimer: null,
  };

  let avatar = null;
  let engine = null;
  let saveTimer = null;
  let speakToken = 0;

  // ----------------------------- 工具 -----------------------------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDuration(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().slice(0, 12);
    return Math.random().toString(36).slice(2, 14);
  }

  function toast(message, kind) {
    const stack = $("#toastStack");
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .25s";
      setTimeout(() => el.remove(), 260);
    }, kind === "error" ? 5200 : 3600);
  }

  async function api(path, options) {
    const res = await fetch(path, options);
    let data = {};
    try {
      data = await res.json();
    } catch (e) {}
    if (!res.ok) {
      const msg = (data.error && data.error.message) || `请求失败（HTTP ${res.status}）`;
      throw new Error(msg);
    }
    return data;
  }

  // ----------------------------- 初始化 -----------------------------
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    buildWave();
    avatar = new window.DigitalAvatar($("#avatar"));
    window.__avatar = avatar; // 调试/测试用句柄
    engine = new window.SpeechEngine();
    engine.onVoices = (voices) => {
      state.voiceList = voices || [];
      fillVoiceSelect();
    };
    state.voiceList = engine.getVoices();

    bindUI();
    startWaveLoop();

    try {
      state.config = await api("/api/config");
    } catch (e) {
      toast("无法连接本地服务，请确认 main.py 已启动", "error");
      state.config = {
        llm: { baseUrl: "", apiKey: "", hasKey: false, model: "gpt-6-luna", temperature: 0.7, maxTokens: 700 },
        asr: { mode: "browser", baseUrl: "", apiKey: "", hasKey: false, model: "whisper-1", language: "en" },
        tts: { mode: "browser", baseUrl: "", apiKey: "", hasKey: false, model: "tts-1", voice: "", rate: 0.98 },
        ui: { avatar: "ava", autoListen: true, subtitles: true },
      };
    }

    try {
      const data = await api("/api/scenarios");
      state.scenarios = data.items || [];
    } catch (e) {
      state.scenarios = [];
      toast("场景脚本加载失败：" + e.message, "error");
    }

    renderScenarioCards();
    fillVoiceSelect();
    applyConfigToUI();
    updateStatus();

    let initial = null;
    const lastId = localStorage.getItem("mirror.lastScenario");
    initial = state.scenarios.find((s) => s.id === lastId) || state.scenarios[0];
    if (initial) {
      applyScenario(initial);
      newSession({ silent: true });
    } else {
      stageStatus("未加载到场景脚本");
    }

    startClock();
    switchTab("chat");
    loadHistory(true);

    // 调试钩子：?testmouth=0.85 固定说话能量，便于无头截图验证口型对齐
    const qp = new URLSearchParams(location.search);
    if (qp.has("testmouth")) {
      const v = Math.max(0, Math.min(1, parseFloat(qp.get("testmouth")) || 0.85));
      state.speaking = true;
      engine.getPlaybackLevel = () => v;
      if (qp.get("avatar")) avatar.setVariant(qp.get("avatar"));
      avatar.setEnergy(v);
      setStageState("speaking");
    }
  }

  // ----------------------------- 通用 UI -----------------------------
  function buildWave() {
    const wave = $("#wave");
    for (let i = 0; i < 42; i++) {
      const span = document.createElement("span");
      span.style.height = "3px";
      wave.appendChild(span);
    }
  }

  function startWaveLoop() {
    const bars = $$("#wave span");
    let last = 0;
    const tick = (now) => {
      const dt = now - last;
      if (dt > 55) {
        last = now;
        const t = now / 1000;
        let level = 0;
        if (state.listening) {
          level = state.asrModeUsed === "api" ? engine.getMicLevel() : 0.32 + Math.sin(t * 5.2) * 0.12 + Math.random() * 0.2;
        } else if (state.speaking) {
          const real = engine.getPlaybackLevel();
          level = real > 0.04 ? real : 0.42 + Math.sin(t * 7.5) * 0.18 + Math.random() * 0.16;
        } else if (state.busy) {
          level = 0.16;
        }
        bars.forEach((bar, i) => {
          const shape = Math.sin(i * 0.55 + t * 4.4) * 0.5 + 0.5;
          const idle = Math.sin(i * 0.72 + t * 2.2) * 0.5 + 0.5;
          const h = level > 0 ? 3 + level * (16 + shape * 22) : 3.5 + idle * 7;
          bar.style.height = Math.max(3, h).toFixed(1) + "px";
        });
        if (state.speaking) {
          const real = engine.getPlaybackLevel();
          avatar.setEnergy(real > 0.02 ? real : null);
        } else if (state.listening) {
          avatar.setEnergy(state.asrModeUsed === "api" ? engine.getMicLevel() : 0.12);
        } else {
          avatar.setEnergy(null);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setStageState(next) {
    $("#stage").dataset.state = next;
    const labels = {
      idle: "待机中 · 点击麦克风开始",
      listening: "正在聆听 · 说完会自动提交",
      thinking: "思考中 · 正在组织回复",
      speaking: "正在说话 · 可随时打断",
    };
    const status = $("#stageStatus");
    if (status) status.textContent = labels[next] || labels.idle;
    if (avatar) avatar.setState(next);
  }

  function stageStatus(text) {
    const el = $("#stageStatus");
    if (el) el.textContent = text;
  }

  function updateMicUI(listening) {
    const btn = $("#btnMic");
    btn.classList.toggle("listening", !!listening);
    btn.setAttribute("aria-label", listening ? "结束录音" : "开始说话");
    $("#deckTitle").textContent = listening ? "正在聆听…" : "按下开始说话";
    $("#deckSub").textContent = listening ? "说完停顿一下即可自动提交" : "支持实时语音对话，也可以直接输入文字";
  }

  function showSubtitle(text, live) {
    const el = $("#subtitle");
    if (!state.config || !state.config.ui.subtitles) {
      el.hidden = true;
      return;
    }
    if (!text) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const shortText = text.length > 110 ? text.slice(0, 110) + "…" : text;
    el.textContent = (live ? "正在聆听 · " : "") + shortText;
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
  }

  function hideSubtitle() {
    $("#subtitle").hidden = true;
  }

  function updateStatus() {
    const chip = $("#statusChip");
    const cfg = state.config;
    const configured = cfg && cfg.llm && cfg.llm.hasKey;
    chip.classList.remove("ok", "err");
    if (configured) {
      chip.classList.add("ok");
      chip.innerHTML = `<i class="dot"></i><span>${esc(cfg.llm.model)} 就绪</span>`;
      $("#noticeBar").hidden = true;
    } else {
      chip.classList.add("err");
      chip.innerHTML = '<i class="dot"></i><span>模型未配置</span>';
      $("#noticeBar").hidden = false;
      $("#noticeText").textContent =
        "尚未配置大模型 API Key。请打开右上角「设置」，填入 Base URL、API Key 与模型名称后即可开始对话。";
    }
  }

  function startClock() {
    if (state.clockTimer) clearInterval(state.clockTimer);
    state.clockTimer = setInterval(() => {
      if (!state.session) return;
      const el = $("#sessionClock");
      el.textContent = fmtDuration(Date.now() - state.session.startedAt);
    }, 1000);
  }

  // ----------------------------- 场景 -----------------------------
  function renderScenarioCards() {
    const groups = { english: $("#scenarioEnglish"), enterprise: $("#scenarioEnterprise") };
    Object.values(groups).forEach((g) => (g.innerHTML = ""));
    state.scenarios.forEach((s) => {
      const host = groups[s.category] || groups.english;
      const card = document.createElement("button");
      card.className = "scenario-card" + (state.scenario && state.scenario.id === s.id ? " current" : "");
      card.type = "button";
      card.innerHTML = `
        <div class="sc-top"><strong>${esc(s.name)}</strong><span class="sc-tag">${esc(s.level || "")}</span></div>
        <p>${esc(s.description || "")}</p>
        <div class="sc-meta"><span>${esc(s.subtitle || "")}</span><span>${esc(s.duration || "")}</span></div>`;
      card.addEventListener("click", () => {
        closeModal($("#scenarioModal"));
        if (state.scenario && state.scenario.id === s.id && !state.readOnly) return;
        const turns = state.session ? state.session.messages.filter((m) => m.role === "user").length : 0;
        if (turns > 0 && !window.confirm("切换场景会开始一段新对话，当前对话已自动保存在历史记录中。继续吗？")) return;
        applyScenario(s);
        newSession();
        speakText(s.opening, { opening: true, force: true });
      });
      host.appendChild(card);
    });
  }

  function applyScenario(scenario) {
    state.scenario = scenario;
    localStorage.setItem("mirror.lastScenario", scenario.id);
    $("#stageScene").textContent = `${scenario.name} · ${scenario.subtitle || ""}`;
    $("#stageLevel").textContent = scenario.level || "";
    $("#avatarName").textContent = scenario.avatar ? scenario.avatar.name : "Ava";
    $("#avatarRole").textContent = scenario.avatar
      ? `${scenario.avatar.role} · ${scenario.avatar.accent}`
      : "英语陪练教练";
    $("#stage").dataset.avatar = scenario.avatar ? scenario.avatar.variant : "ava";
    avatar.setVariant(scenario.avatar ? scenario.avatar.variant : "ava");
    document.title = `${scenario.name} · 镜界 MIRROR`;
    $$(".scenario-card").forEach((c) => c.classList.toggle("current", c.textContent.indexOf(scenario.name) >= 0));
    renderQuickReplies();
  }

  function renderQuickReplies() {
    const row = $("#quickRow");
    row.innerHTML = "";
    const items = (state.scenario && state.scenario.quickReplies) || [];
    items.forEach((text) => {
      const chip = document.createElement("button");
      chip.className = "quick-chip";
      chip.type = "button";
      chip.textContent = text;
      chip.title = "点击直接发送这句话";
      chip.addEventListener("click", () => submitUserText(text, "text"));
      row.appendChild(chip);
    });
    row.style.display = items.length ? "flex" : "none";
  }

  function openScenarioModal() {
    renderScenarioCards();
    openModal($("#scenarioModal"));
  }

  // ----------------------------- 会话 -----------------------------
  function newSession(opts) {
    opts = opts || {};
    if (!state.scenario) return;
    state.session = {
      id: uid(),
      scenarioId: state.scenario.id,
      scenarioName: state.scenario.name,
      category: state.scenario.category,
      title: `${state.scenario.name} · ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      startedAt: Date.now(),
      messages: [],
      evaluation: null,
    };
    state.readOnly = false;
    state.lastAssistantText = "";
    speakToken++;
    engine.stopSpeaking();
    state.speaking = false;
    state.session.messages.push({
      role: "assistant",
      content: state.scenario.opening,
      ts: Date.now(),
      source: "opening",
    });
    renderChat();
    clearEval();
    hideSubtitle();
    setStageState("idle");
    $("#sessionClock").textContent = "00:00";
    $("#btnMic").disabled = false;
    if (!opts.silent) toast(`已切换到「${state.scenario.name}」`, "ok");
  }

  function apiMessages() {
    return (state.session ? state.session.messages : [])
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content && !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  function saveSession() {
    if (!state.session || state.readOnly) return;
    if (!state.session.messages.some((m) => m.role === "user")) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const s = state.session;
      if (!s) return;
      try {
        const data = await api("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: s.id,
            title: s.title,
            scenarioId: s.scenarioId,
            scenarioName: s.scenarioName,
            category: s.category,
            startedAt: new Date(s.startedAt).toISOString(),
            durationSec: Math.floor((Date.now() - s.startedAt) / 1000),
            messages: s.messages.filter((m) => !m.streaming),
            evaluation: s.evaluation,
          }),
        });
        $("#savedHint").textContent = `已保存 ${fmtTime()}`;
        loadHistory(true);
      } catch (e) {
        $("#savedHint").textContent = "保存失败";
      }
    }, 600);
  }

  // ----------------------------- 对话 -----------------------------
  async function submitUserText(text, source) {
    text = (text || "").trim();
    if (!text) return;
    if (!state.session) return;
    if (state.readOnly) {
      toast("当前是历史回放，点击「重置」开始新对话", "warn");
      return;
    }
    if (state.busy) {
      toast("正在等待回复，请稍候", "warn");
      return;
    }
    if (!state.config.llm.hasKey) {
      toast("请先在设置中配置大模型 API Key", "error");
      openSettings();
      return;
    }
    engine.stopSpeaking();
    state.speaking = false;

    const msg = { role: "user", content: text, ts: Date.now(), source: source || "text" };
    state.session.messages.push(msg);
    renderChat();
    scrollChat();
    saveSession();
    await requestReply();
  }

  async function requestReply() {
    state.busy = true;
    setStageState("thinking");
    btnEvaluateState(true);

    const assistant = { role: "assistant", content: "", ts: Date.now(), streaming: true, source: "llm" };
    state.session.messages.push(assistant);
    renderChat();
    scrollChat();

    let ok = false;
    let errorMessage = "";
    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: state.scenario ? state.scenario.id : null, messages: apiMessages() }),
      });
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch (e) {}
        throw new Error((data.error && data.error.message) || `请求失败（HTTP ${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let finished = false;

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = block.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }

          if (payload.type === "delta" && payload.delta) {
            assistant.content += payload.delta;
            updateStreamingText(assistant.content);
            scrollChat();
          } else if (payload.type === "error") {
            throw new Error(payload.message || "模型返回错误");
          } else if (payload.type === "done") {
            if (payload.content && payload.content.length >= assistant.content.length) {
              assistant.content = payload.content;
            }
            finished = true;
            break;
          }
        }
      }
      if (!assistant.content.trim()) throw new Error("模型没有返回内容，请重试");
      ok = true;
      assistant.streaming = false;
      assistant.content = assistant.content.trim();
      state.lastAssistantText = assistant.content;
    } catch (err) {
      errorMessage = err.message || String(err);
      const idx = state.session.messages.indexOf(assistant);
      if (idx >= 0) state.session.messages.splice(idx, 1);
      state.session.messages.push({ role: "system", content: "回复失败：" + errorMessage, ts: Date.now(), error: true });
      toast(errorMessage, "error");
    } finally {
      state.busy = false;
      btnEvaluateState(false);
      renderChat();
      scrollChat();
    }

    if (ok) {
      saveSession();
      await speakText(assistant.content);
      if (state.config.ui.autoListen) scheduleAutoListen();
    } else {
      setStageState("idle");
    }
  }

  function updateStreamingText(text) {
    const el = $("[data-streaming='1'] .msg-text");
    if (el) el.innerHTML = esc(text) + '<span class="cursor"></span>';
  }

  function scrollChat() {
    const list = $("#chatList");
    list.scrollTop = list.scrollHeight;
  }

  function renderChat() {
    const list = $("#chatList");
    if (!state.session) {
      list.innerHTML = "";
      return;
    }
    const avatarName = state.scenario && state.scenario.avatar ? state.scenario.avatar.name : "Ava";
    const html = state.session.messages
      .map((m, i) => {
        if (m.role === "system") {
          return `<div class="msg system${m.error ? " error" : ""}"><span class="msg-text">${esc(m.content)}</span></div>`;
        }
        const isUser = m.role === "user";
        const who = isUser ? "我" : avatarName;
        const initial = isUser ? "ME" : (avatarName[0] || "AI").toUpperCase();
        const tag =
          m.source === "voice" ? "语音" :
          m.source === "opening" ? "开场" :
          isUser ? "文字" : "";
        const actions = !isUser && m.content && !m.streaming
          ? `<div class="msg-actions"><button class="msg-action" data-replay="${i}">重播语音</button></div>`
          : "";
        const body = m.streaming
          ? esc(m.content) + '<span class="cursor"></span>'
          : esc(m.content);
        return `<div class="msg ${isUser ? "user" : "assistant"}"${m.streaming ? " data-streaming=\"1\"" : ""}>
          <div class="msg-avatar">${esc(initial)}</div>
          <div class="msg-main">
            <div class="msg-meta"><strong>${esc(who)}</strong><time>${fmtTime(m.ts)}</time>${tag ? `<span class="msg-tag">${tag}</span>` : ""}</div>
            <div class="msg-text">${body || (m.streaming ? '<div class="typing"><i></i><i></i><i></i></div>' : "")}</div>
            ${actions}
          </div>
        </div>`;
      })
      .join("");
    list.innerHTML = html;
    const turns = state.session.messages.filter((m) => m.role === "user").length;
    $("#turnCounter").textContent = `${turns} 轮对话`;
  }

  // ----------------------------- 语音 -----------------------------
  async function speakText(text, opts) {
    opts = opts || {};
    if (!text || !state.config) return;
    const cfg = state.config;
    const mode = cfg.tts.mode === "api" && cfg.tts.hasKey && cfg.tts.baseUrl ? "api" : "browser";
    const token = ++speakToken;

    state.speaking = true;
    setStageState("speaking");
    showSubtitle(text, false);

    await engine.speak(text, {
      mode,
      voice: cfg.tts.voice || "alloy",
      lang: state.scenario ? state.scenario.ttsLang : "en-US",
      rate: cfg.tts.rate || 1,
      onStart: () => {
        if (token === speakToken) setStageState("speaking");
      },
      onEnd: () => {
        if (token !== speakToken) return;
        state.speaking = false;
        setStageState("idle");
        setTimeout(() => {
          if (token === speakToken) hideSubtitle();
        }, 1600);
      },
      onError: (err) => {
        if (token === speakToken) toast(err.message, "error");
      },
      onFallback: () => {
        if (token === speakToken) toast("云端语音合成不可用，已自动回退到系统语音", "warn");
      },
    });

    if (token !== speakToken || !state.speaking) return;
    state.speaking = false;
    setStageState("idle");
    setTimeout(() => {
      if (token === speakToken) hideSubtitle();
    }, 1600);
  }

  async function speakLast() {
    const list = state.session ? state.session.messages : [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "assistant" && list[i].content) {
        await speakText(list[i].content);
        return;
      }
    }
    toast("还没有可重播的语音", "warn");
  }

  async function toggleMic() {
    if (state.listening) {
      stopListening();
      return;
    }
    if (state.readOnly) {
      toast("当前是历史回放，点击「重置」开始新对话", "warn");
      return;
    }
    if (!state.config.llm.hasKey) {
      toast("请先在设置中配置大模型 API Key", "error");
      openSettings();
      return;
    }
    if (state.busy) {
      toast("正在等待回复，请稍候", "warn");
      return;
    }

    engine.stopSpeaking();
    state.speaking = false;
    state.listening = true;
    speakToken++;
    const cfg = state.config;
    state.asrModeUsed = cfg.asr.mode === "api" && cfg.asr.hasKey && cfg.asr.baseUrl && !state.asrCloudFailed ? "api" : "browser";
    updateMicUI(true);
    setStageState("listening");
    showSubtitle("", true);

    const lang = state.scenario ? state.scenario.asrLang : "en-US";
    const common = {
      lang,
      onPartial: (text) => {
        if (state.listening) showSubtitle(text || "", true);
      },
      onFinal: (text) => {
        endListeningUI();
        submitUserText(text, "voice");
      },
      onError: (err, code) => {
        endListeningUI();
        if (code === "cloud-failed" && !state.asrCloudFailed && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
          state.asrCloudFailed = true;
          toast("云端语音识别不可用，已自动切换为浏览器识别", "warn");
          setTimeout(() => { if (!state.busy && !state.readOnly) toggleMic(); }, 450);
          return;
        }
        if (!err || !err.message) return;
        toast(err.message, code === "no-speech" ? "warn" : "error");
        if (code === "network" || code === "not-allowed" || code === "service-not-allowed") {
          openComposer();
        }
      },
      onEnd: () => {
        // onFinal 会处理提交；这里只保证 UI 复位
        setTimeout(() => {
          if (state.listening) endListeningUI();
        }, 300);
      },
    };

    try {
      if (state.asrModeUsed === "api") {
        const ok = await engine.startApiListening(common);
        if (!ok) endListeningUI();
      } else {
        const ok = engine.startBrowserListening(common);
        if (!ok) endListeningUI();
      }
    } catch (e) {
      endListeningUI();
      toast("麦克风启动失败：" + e.message, "error");
    }
  }

  function endListeningUI() {
    state.listening = false;
    updateMicUI(false);
    setStageState(state.speaking ? "speaking" : "idle");
    hideSubtitle();
    const partial = $("#subtitle");
    if (partial && !state.speaking) partial.hidden = true;
  }

  function stopListening() {
    if (state.asrModeUsed === "api") engine.stopApiListening();
    engine.stopBrowserListening();
    endListeningUI();
  }

  function scheduleAutoListen() {
    setTimeout(() => {
      if (!state.config.ui.autoListen) return;
      if (state.busy || state.listening || state.readOnly) return;
      if ($("#settingsModal") && !$("#settingsModal").hidden) return;
      if ($("#scenarioModal") && !$("#scenarioModal").hidden) return;
      toggleMic();
    }, 750);
  }

  // ----------------------------- 评估 -----------------------------
  function clearEval() {
    $("#evalEmpty").hidden = false;
    $("#evalBody").hidden = true;
    $("#evalBody").innerHTML = "";
  }

  function showEvalLoading() {
    $("#evalEmpty").hidden = true;
    const body = $("#evalBody");
    body.hidden = false;
    body.innerHTML = `
      <div class="eval-loading">
        <div class="loader-ring"></div>
        <strong>正在生成评估报告…</strong>
        <p>模型正在分析本次对话的流利度、语法、词汇与任务完成情况，通常需要 20-60 秒，请保持页面打开。</p>
      </div>`;
  }

  async function evaluate() {
    if (!state.session || state.busy) return;
    const turns = state.session.messages.filter((m) => m.role === "user").length;
    if (!turns) {
      toast("先进行几轮对话再评估吧", "warn");
      return;
    }
    if (state.readOnly) {
      toast("当前为历史回放，无法重新评估", "warn");
      return;
    }
    btnEvaluateState(true);
    state.busy = true;
    const original = $("#btnEvaluate").innerHTML;
    $("#btnEvaluate").textContent = "评估中…";
    switchTab("eval");
    showEvalLoading();

    try {
      const data = await api("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: state.scenario.id, messages: apiMessages() }),
      });
      state.session.evaluation = data.evaluation;
      renderEval(data.evaluation);
      switchTab("eval");
      saveSession();
      toast("评估完成", "ok");
    } catch (e) {
      clearEval();
      toast(e.message, "error");
    } finally {
      state.busy = false;
      btnEvaluateState(false);
      $("#btnEvaluate").innerHTML = original;
    }
  }

  function btnEvaluateState(disabled) {
    $("#btnEvaluate").disabled = !!disabled;
  }

  function scoreColor(score) {
    if (score >= 85) return "var(--teal)";
    if (score >= 70) return "var(--gold)";
    return "var(--coral)";
  }

  function renderEval(ev) {
    if (!ev) return;
    $("#evalEmpty").hidden = true;
    const body = $("#evalBody");
    body.hidden = false;
    const dims = ev.dimensions || [];
    const strengths = ev.strengths || [];
    const improvements = ev.improvements || [];
    const corrections = ev.corrections || [];
    const nextSteps = ev.nextSteps || [];

    body.innerHTML = `
      <div class="score-hero">
        <div class="score-ring" style="--score:${Number(ev.overall) || 0};background:conic-gradient(${scoreColor(Number(ev.overall) || 0)} ${(Number(ev.overall) || 0) * 3.6}deg, rgba(255,255,255,.07) 0)">
          <strong>${Number(ev.overall) || 0}<em>SCORE</em></strong>
        </div>
        <div class="score-copy">
          <strong>本次综合表现</strong>
          <p>${esc(ev.summary || "")}</p>
        </div>
      </div>

      <div class="eval-section">
        <h3>Dimension Breakdown / 维度得分</h3>
        ${dims.map((d) => `
          <div class="dim-row">
            <div class="dim-top"><span>${esc(d.label || d.key)}</span><em>${Number(d.score) || 0}</em></div>
            <div class="dim-bar"><i data-width="${Number(d.score) || 0}"></i></div>
            <div class="dim-comment">${esc(d.comment || "")}</div>
          </div>`).join("")}
      </div>

      ${strengths.length ? `<div class="eval-section"><h3>Strengths / 亮点</h3><ul class="tip-list">${strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      ${improvements.length ? `<div class="eval-section"><h3>To Improve / 待提升</h3><ul class="tip-list improve">${improvements.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      ${corrections.length ? `<div class="eval-section"><h3>Corrections / 表达纠正</h3>${corrections.map((c) => `
        <div class="correction">
          <div class="orig">${esc(c.original || "")}</div>
          <div class="fixed">${esc(c.revised || "")}</div>
          <div class="note">${esc(c.note || "")}</div>
        </div>`).join("")}</div>` : ""}
      ${nextSteps.length ? `<div class="eval-section"><h3>Next Steps / 下一步</h3><ul class="tip-list">${nextSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      <div class="eval-meta">${esc(state.scenario ? state.scenario.name : "")} · 生成于 ${fmtTime()}</div>
    `;

    setTimeout(() => {
      $$(".dim-bar i", body).forEach((bar) => {
        bar.style.width = Math.max(2, Math.min(100, Number(bar.dataset.width) || 0)) + "%";
      });
    }, 60);
  }

  // ----------------------------- 历史 -----------------------------
  async function loadHistory(quiet) {
    try {
      const data = await api("/api/sessions");
      const items = data.items || [];
      const list = $("#historyList");
      if (!items.length) {
        list.innerHTML = '<div class="history-empty">还没有保存的会话<br/>完成一轮对话后会自动保存到本地</div>';
        return;
      }
      list.innerHTML = items
        .map((it) => `
          <div class="history-item" data-id="${esc(it.id)}">
            <div class="hi-top">
              <strong>${esc(it.title || it.scenarioName || "未命名会话")}</strong>
              ${it.score != null ? `<span class="hi-score">${it.score}</span>` : ""}
            </div>
            <div class="hi-meta">
              <span>${esc(it.scenarioName || "")}</span>
              <span>${it.turns || 0} 轮</span>
              <span>${esc((it.updatedAt || "").slice(5, 16))}</span>
            </div>
          </div>`)
        .join("");
    } catch (e) {
      if (!quiet) toast("读取历史会话失败：" + e.message, "error");
    }
  }

  async function openReplay(id) {
    try {
      const record = await api("/api/sessions/" + encodeURIComponent(id));
      state.replayRecord = record;
      $("#replayTitle").textContent = record.title || "会话回放";
      $("#replayBody").innerHTML = (record.messages || [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `<div class="r-msg ${m.role}"><span>${m.role === "user" ? "学员" : "数字人陪练"}</span><p>${esc(m.content)}</p></div>`)
        .join("");
      openModal($("#replayModal"));
    } catch (e) {
      toast("加载会话失败：" + e.message, "error");
    }
  }

  function loadReplayToChat() {
    const record = state.replayRecord;
    if (!record) return;
    const sc = state.scenarios.find((s) => s.id === record.scenarioId) || state.scenarios[0];
    if (sc) applyScenario(sc);
    state.readOnly = true;
    state.session = {
      id: record.id,
      scenarioId: record.scenarioId,
      scenarioName: record.scenarioName,
      category: record.category,
      title: record.title,
      startedAt: new Date(record.startedAt || Date.now()).getTime(),
      messages: (record.messages || []).map((m) => ({ ...m })),
      evaluation: record.evaluation || null,
    };
    renderChat();
    if (record.evaluation) renderEval(record.evaluation);
    else clearEval();
    closeModal($("#replayModal"));
    $("#btnMic").disabled = true;
    stageStatus("历史回放中 · 点击「重置」开始新对话");
    setStageState("idle");
    toast("已载入历史会话（只读）", "ok");
  }

  function exportRecord() {
    const record = state.replayRecord;
    if (!record) return;
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(record.title || "session").replace(/[\\/:*?"<>|]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("已导出 JSON", "ok");
  }

  // ----------------------------- 设置 -----------------------------
  function fillVoiceSelect() {
    const sel = $("#cfgTtsVoice");
    if (!sel) return;
    const current = (state.config && state.config.tts && state.config.tts.voice) || sel.value || "";
    const list = state.voiceList || [];
    sel.innerHTML = '<option value="">系统默认音色</option>';
    list.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} · ${v.lang}${v.default ? " (默认)" : ""}`;
      sel.appendChild(opt);
    });
    if (current) {
      const exists = Array.from(sel.options).some((o) => o.value === current);
      if (!exists) {
        const opt = document.createElement("option");
        opt.value = current;
        opt.textContent = current + "（已保存）";
        sel.appendChild(opt);
      }
      sel.value = current;
    }
  }

  function applyConfigToUI() {
    const cfg = state.config;
    if (!cfg) return;
    $("#cfgLlmBase").value = cfg.llm.baseUrl || "";
    $("#cfgLlmKey").value = "";
    $("#cfgLlmKey").placeholder = cfg.llm.hasKey ? "已保存，留空表示不修改" : "sk-...";
    $("#cfgLlmModel").value = cfg.llm.model || "";
    $("#cfgLlmTokens").value = cfg.llm.maxTokens || 700;
    $("#cfgTemp").value = cfg.llm.temperature != null ? cfg.llm.temperature : 0.7;
    $("#tempValue").textContent = Number($("#cfgTemp").value).toFixed(2);

    $("#cfgAsrBase").value = cfg.asr.baseUrl || "";
    $("#cfgAsrKey").value = "";
    $("#cfgAsrKey").placeholder = cfg.asr.hasKey ? "已保存，留空表示不修改" : "sk-...";
    $("#cfgAsrModel").value = cfg.asr.model || "";
    $("#cfgAsrLang").value = cfg.asr.language || "en";

    $("#cfgTtsBase").value = cfg.tts.baseUrl || "";
    $("#cfgTtsKey").value = "";
    $("#cfgTtsKey").placeholder = cfg.tts.hasKey ? "已保存，留空表示不修改" : "sk-...";
    $("#cfgTtsModel").value = cfg.tts.model || "tts-1";
    $("#cfgTtsVoiceApi").value = cfg.tts.voice || "alloy";
    $("#cfgTtsRate").value = cfg.tts.rate || 0.98;
    $("#rateValue").textContent = Number($("#cfgTtsRate").value).toFixed(2);
    fillVoiceSelect();

    setSeg("asrModeSeg", cfg.asr.mode || "browser", $("#asrApiFields"));
    setSeg("ttsModeSeg", cfg.tts.mode || "browser", $("#ttsApiFields"));

    $("#cfgAvatar").value = cfg.ui.avatar || "ava";
    $("#cfgAutoListen").value = String(cfg.ui.autoListen !== false);
    $("#cfgSubtitles").value = String(cfg.ui.subtitles !== false);

    avatar.setVariant(cfg.ui.avatar || "ava");
    $("#stage").dataset.avatar = cfg.ui.avatar || "ava";
  }

  function setSeg(segId, value, fields) {
    const seg = $("#" + segId);
    $$("button", seg).forEach((b) => b.classList.toggle("active", b.dataset.value === value));
    if (fields) fields.hidden = value !== "api";
  }

  function openSettings() {
    applyConfigToUI();
    openModal($("#settingsModal"));
  }

  async function saveConfig() {
    const payload = {
      llm: {
        baseUrl: $("#cfgLlmBase").value.trim(),
        apiKey: $("#cfgLlmKey").value.trim(),
        model: $("#cfgLlmModel").value.trim() || "gpt-6-luna",
        maxTokens: Number($("#cfgLlmTokens").value) || 700,
        temperature: Number($("#cfgTemp").value),
      },
      asr: {
        mode: $("#asrModeSeg .active").dataset.value,
        baseUrl: $("#cfgAsrBase").value.trim(),
        apiKey: $("#cfgAsrKey").value.trim(),
        model: $("#cfgAsrModel").value.trim() || "whisper-1",
        language: $("#cfgAsrLang").value.trim() || "en",
      },
      tts: {
        mode: $("#ttsModeSeg .active").dataset.value,
        baseUrl: $("#cfgTtsBase").value.trim(),
        apiKey: $("#cfgTtsKey").value.trim(),
        model: $("#cfgTtsModel").value.trim() || "tts-1",
        voice: $("#ttsModeSeg .active").dataset.value === "api" ? $("#cfgTtsVoiceApi").value.trim() || "alloy" : $("#cfgTtsVoice").value,
        rate: Number($("#cfgTtsRate").value) || 1,
      },
      ui: {
        avatar: $("#cfgAvatar").value,
        autoListen: $("#cfgAutoListen").value === "true",
        subtitles: $("#cfgSubtitles").value === "true",
      },
    };
    try {
      const data = await api("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      state.config = data.config;
      updateStatus();
      applyConfigToUI();
      closeModal($("#settingsModal"));
      toast("配置已保存", "ok");
    } catch (e) {
      toast("保存失败：" + e.message, "error");
    }
  }

  async function testLlm() {
    const result = $("#testResult");
    result.className = "test-result";
    result.textContent = "测试中…";
    const t0 = Date.now();
    try {
      const data = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenarioId: state.scenario ? state.scenario.id : null,
          messages: [{ role: "user", content: "请只回复两个字：正常" }],
        }),
      });
      result.className = "test-result ok";
      result.textContent = `连接正常 · ${Date.now() - t0}ms · 返回「${(data.content || "").trim().slice(0, 20)}」`;
    } catch (e) {
      result.className = "test-result err";
      result.textContent = e.message;
    }
  }

  async function loadModels() {
    const result = $("#testResult");
    result.className = "test-result";
    result.textContent = "拉取中…";
    try {
      const data = await api("/api/models");
      const list = $("#modelList");
      list.innerHTML = "";
      (data.items || []).forEach((id) => {
        const opt = document.createElement("option");
        opt.value = id;
        list.appendChild(opt);
      });
      result.className = "test-result ok";
      result.textContent = data.items && data.items.length ? `已获取 ${data.items.length} 个模型，可在模型输入框中选择` : (data.note || "未获取到模型列表");
    } catch (e) {
      result.className = "test-result err";
      result.textContent = e.message;
    }
  }

  function openComposer() {
    $("#composer").classList.add("open");
    $("#btnText").classList.add("active");
    setTimeout(() => $("#textInput").focus(), 30);
  }

  // ----------------------------- 弹窗 -----------------------------
  function openModal(el) {
    el.hidden = false;
  }
  function closeModal(el) {
    el.hidden = true;
  }

  function switchTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
    if (name === "history") loadHistory(false);
  }

  // ----------------------------- 事件绑定 -----------------------------
  function bindUI() {
    $("#btnMic").addEventListener("click", toggleMic);
    $("#btnReplay").addEventListener("click", speakLast);
    $("#btnEvaluate").addEventListener("click", evaluate);
    $("#btnReset").addEventListener("click", () => {
      if (!state.scenario) return;
      const turns = state.session ? state.session.messages.filter((m) => m.role === "user").length : 0;
      if (turns > 0 && !window.confirm("重置会开始一段新对话，当前记录已自动保存。继续吗？")) return;
      newSession();
      toast("已重置对话", "ok");
    });
    $("#btnText").addEventListener("click", () => {
      const composer = $("#composer");
      if (composer.classList.contains("open")) {
        composer.classList.remove("open");
      } else {
        openComposer();
      }
    });
    $("#btnCloseComposer").addEventListener("click", () => $("#composer").classList.remove("open"));
    $("#btnSend").addEventListener("click", sendComposer);
    $("#textInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendComposer();
      }
    });
    $("#textInput").addEventListener("input", () => {
      const el = $("#textInput");
      el.style.height = "auto";
      el.style.height = Math.min(110, el.scrollHeight) + "px";
    });

    $("#btnSettings").addEventListener("click", openSettings);
    $("#noticeAction").addEventListener("click", openSettings);
    $("#btnScenario").addEventListener("click", openScenarioModal);

    $$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
    $("#chatList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-replay]");
      if (!btn) return;
      const idx = Number(btn.dataset.replay);
      const m = state.session && state.session.messages[idx];
      if (m) speakText(m.content);
    });
    $("#historyList").addEventListener("click", (e) => {
      const item = e.target.closest(".history-item");
      if (item) openReplay(item.dataset.id);
    });

    $$("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const modal = btn.closest(".modal");
        if (modal) closeModal(modal);
      });
    });
    $("#replayBody").addEventListener("click", () => {});
    $("#btnReplayExport").addEventListener("click", exportRecord);
    $("#btnReplayLoad").addEventListener("click", loadReplayToChat);

    // 设置：分段控件
    $$("#asrModeSeg button").forEach((b) => {
      b.addEventListener("click", () => setSeg("asrModeSeg", b.dataset.value, $("#asrApiFields")));
    });
    $$("#ttsModeSeg button").forEach((b) => {
      b.addEventListener("click", () => setSeg("ttsModeSeg", b.dataset.value, $("#ttsApiFields")));
    });
    $("#cfgTemp").addEventListener("input", () => {
      $("#tempValue").textContent = Number($("#cfgTemp").value).toFixed(2);
    });
    $("#cfgTtsRate").addEventListener("input", () => {
      $("#rateValue").textContent = Number($("#cfgTtsRate").value).toFixed(2);
    });
    $("#btnRevealKey").addEventListener("click", () => {
      const input = $("#cfgLlmKey");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("#btnRevealKey").textContent = show ? "隐藏" : "显示";
    });
    $("#btnSaveConfig").addEventListener("click", saveConfig);
    $("#btnTestLlm").addEventListener("click", testLlm);
    $("#btnLoadModels").addEventListener("click", loadModels);

    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "Escape") {
        const open = $$(".modal").find((m) => !m.hidden);
        if (open) closeModal(open);
        return;
      }
      if (e.code === "Space" && !typing && !$$(".modal").some((m) => !m.hidden)) {
        e.preventDefault();
        toggleMic();
      }
    });

    window.addEventListener("beforeunload", () => {
      if (engine) engine.stopAll();
    });
  }

  function sendComposer() {
    const input = $("#textInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    submitUserText(text, "text");
  }
})();
