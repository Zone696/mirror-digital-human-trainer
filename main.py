#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数字人陪练 Windows Demo —— 本地后端服务
纯 Python 标准库实现，无需 pip 安装任何依赖。

职责：
  1. 托管前端静态页面
  2. 代理 LLM（OpenAI 兼容协议，支持流式）
  3. 代理 ASR / TTS（可选，OpenAI 兼容协议；不配置时前端使用浏览器原生能力）
  4. 场景脚本读取、会话记录本地 JSON 持久化
"""

import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(ROOT, "data")
SCENARIO_DIR = os.path.join(DATA_DIR, "scenarios")
SESSION_DIR = os.path.join(DATA_DIR, "sessions")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
CONFIG_EXAMPLE = os.path.join(DATA_DIR, "config.example.json")

APP_VERSION = "1.0.0"
DEFAULT_PORT = int(os.environ.get("PORT", "8765"))

DEFAULT_CONFIG = {
    "llm": {
        "baseUrl": "https://api.a6api.com/v1",
        "apiKey": "",
        "model": "gpt-6-luna",
        "temperature": 0.7,
        "maxTokens": 700,
    },
    "asr": {
        "mode": "browser",
        "baseUrl": "",
        "apiKey": "",
        "model": "whisper-1",
        "language": "en",
    },
    "tts": {
        "mode": "browser",
        "baseUrl": "",
        "apiKey": "",
        "model": "tts-1",
        "voice": "alloy",
        "rate": 0.98,
    },
    "ui": {
        "avatar": "ava",
        "autoListen": True,
        "subtitles": True,
        "showTranslation": False,
    },
}

_config_lock = threading.Lock()
_models_cache = {"time": 0, "data": []}


# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------
def ensure_dirs():
    for d in (DATA_DIR, SCENARIO_DIR, SESSION_DIR):
        os.makedirs(d, exist_ok=True)


def deep_merge(base, patch):
    out = dict(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config():
    ensure_dirs()
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = deep_merge(cfg, json.load(f))
        except Exception as exc:  # 配置损坏时回退默认值，避免服务无法启动
            print(f"[config] 读取失败，使用默认配置: {exc}")
    if not cfg["llm"].get("apiKey"):
        cfg["llm"]["apiKey"] = os.environ.get("LLM_API_KEY", "")
    return cfg


def save_config(cfg):
    ensure_dirs()
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def masked_config(cfg):
    """返回给前端的配置：隐藏密钥明文，仅暴露是否已配置。"""
    safe = json.loads(json.dumps(cfg))
    for section in ("llm", "asr", "tts"):
        key = safe.get(section, {}).get("apiKey", "")
        safe[section]["apiKey"] = ""
        safe[section]["hasKey"] = bool(key)
    return safe


def api_error(message, status=400):
    return {"error": {"message": message}}, status


def http_json(url, api_key, payload=None, method=None, timeout=120):
    body = None
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method or ("POST" if body else "GET"))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        if "application/json" in ctype:
            return json.loads(raw.decode("utf-8", "ignore"))
        return {"raw": raw.decode("utf-8", "ignore")}


def upstream_error(exc):
    """把 urllib 异常转换成可读的中文提示。"""
    if isinstance(exc, urllib.error.HTTPError):
        detail = ""
        try:
            raw = exc.read().decode("utf-8", "ignore")
            data = json.loads(raw)
            detail = (data.get("error") or {}).get("message") or raw
        except Exception:
            detail = ""
        if exc.code == 401:
            return f"API Key 无效或无权限（HTTP 401）{('：' + detail) if detail else ''}"
        if exc.code == 429:
            return f"请求过于频繁或额度不足（HTTP 429）{('：' + detail) if detail else ''}"
        return f"上游服务返回 HTTP {exc.code}{('：' + detail) if detail else ''}"
    if isinstance(exc, urllib.error.URLError):
        return f"无法连接上游服务（{exc.reason}），请检查网络或 Base URL"
    if isinstance(exc, socket.timeout):
        return "上游服务响应超时，请稍后重试"
    return f"请求失败：{exc}"


def extract_json(text):
    """从模型输出中提取 JSON（容忍 markdown 代码块与前后说明文字）。"""
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(cleaned[start:end + 1])
        except Exception:
            return None
    return None


def load_scenarios():
    items = []
    if not os.path.isdir(SCENARIO_DIR):
        return items
    for name in sorted(os.listdir(SCENARIO_DIR)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(SCENARIO_DIR, name), "r", encoding="utf-8") as f:
                data = json.load(f)
            data.setdefault("id", os.path.splitext(name)[0])
            items.append(data)
        except Exception as exc:
            print(f"[scenario] 跳过 {name}: {exc}")
    order = {"english": 0, "enterprise": 1}
    items.sort(key=lambda s: (order.get(s.get("category"), 9), s.get("order", 99)))
    return items


def get_scenario(scenario_id):
    for s in load_scenarios():
        if s.get("id") == scenario_id:
            return s
    return None


def session_meta(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {
            "id": data.get("id"),
            "title": data.get("title") or "未命名会话",
            "scenarioId": data.get("scenarioId"),
            "scenarioName": data.get("scenarioName"),
            "category": data.get("category"),
            "startedAt": data.get("startedAt"),
            "updatedAt": data.get("updatedAt"),
            "turns": len([m for m in data.get("messages", []) if m.get("role") == "user"]),
            "score": (data.get("evaluation") or {}).get("overall"),
        }
    except Exception:
        return None


# ----------------------------------------------------------------------------
# 评估
# ----------------------------------------------------------------------------
DEFAULT_DIMENSIONS = [
    {"key": "fluency", "label": "流利度", "weight": 0.25},
    {"key": "grammar", "label": "语法准确", "weight": 0.25},
    {"key": "vocabulary", "label": "词汇表达", "weight": 0.2},
    {"key": "task", "label": "任务完成", "weight": 0.3},
]


def build_eval_messages(scenario, messages):
    dims = (scenario or {}).get("evaluation", {}).get("dimensions") or DEFAULT_DIMENSIONS
    goals = (scenario or {}).get("goals") or []
    lines = []
    for m in messages:
        if m.get("role") not in ("user", "assistant"):
            continue
        who = "学员" if m["role"] == "user" else "陪练"
        lines.append(f"{who}：{m.get('content', '').strip()}")
    transcript = "\n".join(lines) if lines else "（学员尚未发言）"
    dim_text = "\n".join(f'- {d["key"]}（{d["label"]}）' for d in dims)
    goal_text = "\n".join(f"- {g}" for g in goals) or "- 完成场景对话目标"
    system = (
        "你是一名严格但友善的口语与沟通能力评估官。你需要基于真实对话记录给出可执行的反馈。"
        "只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释性前后缀。所有评语使用简体中文，"
        "英文原句保留英文。"
    )
    user = f"""请评估下面这段陪练对话。

【场景】{(scenario or {}).get('name', '通用口语陪练')} —— {(scenario or {}).get('subtitle', '')}
【训练目标】
{goal_text}
【评分维度】（每项 0-100 分，请严格使用以下 key）
{dim_text}

【对话记录】
{transcript}

输出 JSON，结构必须完全如下：
{{
  "overall": 0-100 的整数,
  "summary": "80-120 字总体评价，指出最突出的优点和最需要改进的一点",
  "dimensions": [
    {{"key": "维度 key", "label": "维度中文名", "score": 0-100, "comment": "30-60 字具体评价"}}
  ],
  "strengths": ["2-3 条具体优点"],
  "improvements": ["2-3 条可执行改进建议"],
  "corrections": [
    {{"original": "学员原句", "revised": "更正后的表达", "note": "中文说明修改原因"}}
  ],
  "nextSteps": ["2 条下一步练习建议"]
}}
要求：corrections 最多 3 条，只挑最有代表性的错误；若学员回答过短，请在 summary 中指出样本不足。"""
    return [{"role": "system", "content": system}, {"role": "user", "content": user}], dims


# ----------------------------------------------------------------------------
# HTTP Handler
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "DigitalTrainer/" + APP_VERSION
    protocol_version = "HTTP/1.1"

    # ---------- 基础响应 ----------
    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}\n")

    # ---------- 路由 ----------
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/health":
                cfg = load_config()
                return self._send_json({
                    "ok": True,
                    "version": APP_VERSION,
                    "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "llmConfigured": bool(cfg["llm"]["apiKey"]),
                    "asrMode": cfg["asr"]["mode"],
                    "ttsMode": cfg["tts"]["mode"],
                    "python": sys.version.split(" ")[0],
                })
            if path == "/api/config":
                return self._send_json(masked_config(load_config()))
            if path == "/api/scenarios":
                return self._send_json({"items": load_scenarios()})
            if path == "/api/models":
                return self._handle_models()
            if path == "/api/sessions":
                return self._handle_session_list()
            if path.startswith("/api/sessions/"):
                return self._handle_session_get(path.rsplit("/", 1)[-1])
            return self._serve_static(path)
        except BrokenPipeError:
            pass
        except Exception as exc:
            print(f"[error] GET {path}: {exc}")
            self._send_json({"error": {"message": f"服务端异常：{exc}"}}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/config":
                return self._handle_config_save()
            if path == "/api/chat/stream":
                return self._handle_chat_stream()
            if path == "/api/chat":
                return self._handle_chat()
            if path == "/api/evaluate":
                return self._handle_evaluate()
            if path == "/api/asr":
                return self._handle_asr(parse_qs(parsed.query))
            if path == "/api/tts":
                return self._handle_tts()
            if path == "/api/sessions":
                return self._handle_session_save()
            self._send_json({"error": {"message": "接口不存在"}}, 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            print(f"[error] POST {path}: {exc}")
            try:
                self._send_json({"error": {"message": f"服务端异常：{exc}"}}, 500)
            except Exception:
                pass

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/sessions/"):
            sid = os.path.basename(path)
            target = os.path.join(SESSION_DIR, sid + ".json")
            if os.path.exists(target):
                os.remove(target)
                return self._send_json({"ok": True})
            return self._send_json({"error": {"message": "会话不存在"}}, 404)
        self._send_json({"error": {"message": "接口不存在"}}, 404)

    # ---------- 静态资源 ----------
    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = unquote(path).lstrip("/")
        target = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not target.startswith(os.path.abspath(PUBLIC_DIR) + os.sep) and target != os.path.abspath(PUBLIC_DIR):
            return self._send_json({"error": {"message": "非法路径"}}, 403)
        if not os.path.isfile(target):
            return self._send_json({"error": {"message": "文件不存在"}}, 404)
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".ico": "image/x-icon",
            ".woff2": "font/woff2",
        }.get(os.path.splitext(target)[1].lower(), "application/octet-stream")
        with open(target, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---------- 模型列表 ----------
    def _handle_models(self):
        cfg = load_config()
        key = cfg["llm"]["apiKey"]
        if not key:
            return self._send_json({"items": [], "note": "尚未配置 API Key"})
        if time.time() - _models_cache["time"] < 300 and _models_cache["data"]:
            return self._send_json({"items": _models_cache["data"]})
        try:
            data = http_json(cfg["llm"]["baseUrl"].rstrip("/") + "/models", key, timeout=20)
            ids = sorted(m.get("id") for m in data.get("data", []) if m.get("id"))
            _models_cache.update({"time": time.time(), "data": ids})
            return self._send_json({"items": ids})
        except Exception as exc:
            return self._send_json({"items": [], "note": upstream_error(exc)})

    # ---------- 配置 ----------
    def _handle_config_save(self):
        payload = self._read_json()
        with _config_lock:
            cfg = load_config()
            patch = json.loads(json.dumps(payload))
            for section in ("llm", "asr", "tts"):
                if section in patch and not patch[section].get("apiKey"):
                    patch[section].pop("apiKey", None)
            cfg = deep_merge(cfg, patch)
            save_config(cfg)
        return self._send_json({"ok": True, "config": masked_config(cfg)})

    # ---------- 对话 ----------
    def _messages_from_payload(self, payload):
        messages = payload.get("messages") or []
        scenario = get_scenario(payload.get("scenarioId") or "") or {}
        system = scenario.get("systemPrompt") or (
            "你是一名友好的 AI 陪练教练，用简洁自然的口语与学员对话，每次回复不超过 3 句话。"
        )
        extra = payload.get("systemExtra") or ""
        if extra:
            system += "\n\n" + extra
        cleaned = [{"role": "system", "content": system}]
        for m in messages[-24:]:
            role = m.get("role")
            content = (m.get("content") or "").strip()
            if role in ("user", "assistant") and content:
                cleaned.append({"role": role, "content": content})
        return cleaned, scenario

    def _llm_payload(self, cfg, messages, stream=False, max_tokens=None):
        return {
            "model": cfg["llm"]["model"],
            "messages": messages,
            "temperature": float(cfg["llm"].get("temperature", 0.7)),
            "max_tokens": int(max_tokens or cfg["llm"].get("maxTokens", 700)),
            "stream": bool(stream),
        }

    def _handle_chat_stream(self):
        payload = self._read_json()
        cfg = load_config()
        if not cfg["llm"]["apiKey"]:
            return self._send_json({"error": {"message": "尚未配置大模型 API Key，请打开右上角「设置」填写"}}, 400)
        messages, _ = self._messages_from_payload(payload)
        body = self._llm_payload(cfg, messages, stream=True)
        url = cfg["llm"]["baseUrl"].rstrip("/") + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {cfg['llm']['apiKey']}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
        )

        # 先建立上游连接，失败时还能返回规范 JSON 错误
        try:
            resp = urllib.request.urlopen(req, timeout=120)
        except Exception as exc:
            return self._send_json({"error": {"message": upstream_error(exc)}}, 502)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def emit(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        full = []
        started = time.time()
        try:
            emit({"type": "start"})
            for raw in resp:
                line = raw.decode("utf-8", "ignore").strip()
                if not line or not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    data = json.loads(chunk)
                except Exception:
                    continue
                choices = data.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                piece = delta.get("content")
                if piece:
                    full.append(piece)
                    emit({"type": "delta", "delta": piece})
            text = "".join(full).strip()
            if not text:
                emit({"type": "error", "message": "模型未返回内容，请重试或更换模型"})
            else:
                emit({"type": "done", "content": text, "elapsed": round(time.time() - started, 2)})
        except Exception as exc:
            try:
                emit({"type": "error", "message": upstream_error(exc)})
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _handle_chat(self):
        payload = self._read_json()
        cfg = load_config()
        if not cfg["llm"]["apiKey"]:
            return self._send_json({"error": {"message": "尚未配置大模型 API Key"}}, 400)
        messages, _ = self._messages_from_payload(payload)
        body = self._llm_payload(cfg, messages, stream=False)
        try:
            data = http_json(cfg["llm"]["baseUrl"].rstrip("/") + "/chat/completions", cfg["llm"]["apiKey"], body)
        except Exception as exc:
            return self._send_json({"error": {"message": upstream_error(exc)}}, 502)
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
        return self._send_json({"content": content, "usage": data.get("usage")})

    # ---------- 评估 ----------
    def _handle_evaluate(self):
        payload = self._read_json()
        cfg = load_config()
        if not cfg["llm"]["apiKey"]:
            return self._send_json({"error": {"message": "尚未配置大模型 API Key"}}, 400)
        scenario = get_scenario(payload.get("scenarioId") or "") or {}
        messages = payload.get("messages") or []
        if not any(m.get("role") == "user" for m in messages):
            return self._send_json({"error": {"message": "还没有你的发言，先聊几句再评估吧"}}, 400)
        eval_messages, dims = build_eval_messages(scenario, messages)
        body = self._llm_payload(cfg, eval_messages, stream=False, max_tokens=900)
        body["temperature"] = 0.2
        try:
            data = http_json(cfg["llm"]["baseUrl"].rstrip("/") + "/chat/completions", cfg["llm"]["apiKey"], body)
        except Exception as exc:
            return self._send_json({"error": {"message": upstream_error(exc)}}, 502)
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
        result = extract_json(content)
        if not result:
            return self._send_json({"error": {"message": "评估结果解析失败，请重试"}, "raw": content}, 502)
        # 补全缺失维度，保证前端渲染稳定
        got = {d.get("key"): d for d in result.get("dimensions", [])}
        result["dimensions"] = [
            got.get(d["key"]) or {"key": d["key"], "label": d["label"], "score": 0, "comment": "本次对话未覆盖该维度"}
            for d in dims
        ]
        try:
            result["overall"] = int(round(float(result.get("overall", 0))))
        except Exception:
            result["overall"] = 0
        return self._send_json({"evaluation": result, "scenarioId": payload.get("scenarioId")})

    # ---------- ASR ----------
    def _handle_asr(self, query):
        cfg = load_config()
        asr = cfg["asr"]
        if asr.get("mode") != "api" or not (asr.get("baseUrl") and asr.get("apiKey")):
            return self._send_json({"error": {"message": "未启用云端语音识别，请在设置中配置 ASR 服务"}}, 400)
        audio = self._read_body()
        if not audio:
            return self._send_json({"error": {"message": "没有收到音频数据"}}, 400)
        mime = (query.get("mime") or ["audio/webm"])[0]
        ext = {"audio/webm": "webm", "audio/wav": "wav", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3"}.get(mime, "webm")
        boundary = "----Trainer" + uuid.uuid4().hex
        parts = []
        for name, value in (("model", asr.get("model") or "whisper-1"), ("language", asr.get("language") or "en")):
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.{ext}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n".encode() + audio + b"\r\n"
        )
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(
            asr["baseUrl"].rstrip("/") + "/audio/transcriptions",
            data=body,
            headers={
                "Authorization": f"Bearer {asr['apiKey']}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read().decode("utf-8", "ignore"))
            return self._send_json({"text": (data.get("text") or "").strip()})
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "ignore")
            # 网关在无法处理音频转写时会返回 500 + request_id，转成可操作建议
            if exc.code >= 500 or "request_id" in raw:
                return self._send_json(
                    {"error": {"message": "云端语音识别失败：当前网关不支持音频转写（模型列表中无音频模型）。请在设置中将 ASR 切换为「浏览器识别」。"}},
                    502,
                )
            return self._send_json({"error": {"message": upstream_error(exc)}}, 502)
        except Exception as exc:
            return self._send_json({"error": {"message": upstream_error(exc)}}, 502)

    # ---------- TTS ----------
    def _handle_tts(self):
        payload = self._read_json()
        cfg = load_config()
        tts = cfg["tts"]
        text = (payload.get("text") or "").strip()
        if not text:
            return self._send_json({"error": {"message": "文本为空"}}, 400)
        if tts.get("mode") != "api" or not (tts.get("baseUrl") and tts.get("apiKey")):
            return self._send_json({"error": {"message": "未启用云端语音合成"}}, 400)
        body = {
            "model": tts.get("model") or "tts-1",
            "voice": payload.get("voice") or tts.get("voice") or "alloy",
            "input": text[:2000],
            "response_format": "mp3",
        }
        req = urllib.request.Request(
            tts["baseUrl"].rstrip("/") + "/audio/speech",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {tts['apiKey']}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                audio = resp.read()
                ctype = resp.headers.get("Content-Type", "audio/mpeg")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(audio)
        except Exception as exc:
            return self._send_json({"error": {"message": upstream_error(exc)}}, 502)

    # ---------- 会话 ----------
    def _handle_session_list(self):
        items = []
        if os.path.isdir(SESSION_DIR):
            for name in os.listdir(SESSION_DIR):
                if name.endswith(".json"):
                    meta = session_meta(os.path.join(SESSION_DIR, name))
                    if meta:
                        items.append(meta)
        items.sort(key=lambda m: m.get("updatedAt") or "", reverse=True)
        return self._send_json({"items": items[:100]})

    def _handle_session_get(self, sid):
        sid = os.path.basename(sid)
        target = os.path.join(SESSION_DIR, sid + ".json")
        if not os.path.isfile(target):
            return self._send_json({"error": {"message": "会话不存在"}}, 404)
        with open(target, "r", encoding="utf-8") as f:
            return self._send_json(json.load(f))

    def _handle_session_save(self):
        payload = self._read_json()
        sid = payload.get("id") or uuid.uuid4().hex[:12]
        sid = re.sub(r"[^a-zA-Z0-9_-]", "", str(sid))[:40] or uuid.uuid4().hex[:12]
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        record = {
            "id": sid,
            "title": payload.get("title") or "未命名会话",
            "scenarioId": payload.get("scenarioId"),
            "scenarioName": payload.get("scenarioName"),
            "category": payload.get("category"),
            "startedAt": payload.get("startedAt") or now,
            "updatedAt": now,
            "durationSec": payload.get("durationSec"),
            "messages": payload.get("messages") or [],
            "evaluation": payload.get("evaluation"),
        }
        ensure_dirs()
        with open(os.path.join(SESSION_DIR, sid + ".json"), "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        return self._send_json({"ok": True, "id": sid, "savedAt": now})


# ----------------------------------------------------------------------------
def open_browser_later(port):
    time.sleep(0.8)
    try:
        webbrowser.open(f"http://127.0.0.1:{port}")
    except Exception:
        pass


def main():
    ensure_dirs()
    if not os.path.exists(CONFIG_PATH) and os.path.exists(CONFIG_EXAMPLE):
        with open(CONFIG_EXAMPLE, "r", encoding="utf-8") as f:
            save_config(deep_merge(DEFAULT_CONFIG, json.load(f)))

    port = DEFAULT_PORT
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True

    cfg = load_config()
    print("=" * 62)
    print(f"  AI 数字人陪练 Demo  v{APP_VERSION}")
    print(f"  地址: http://127.0.0.1:{port}")
    print(f"  模型: {cfg['llm']['model']}  (API Key {'已配置' if cfg['llm']['apiKey'] else '未配置'})")
    print(f"  ASR : {cfg['asr']['mode']}    TTS: {cfg['tts']['mode']}")
    print("  按 Ctrl+C 停止服务")
    print("=" * 62)

    if "--no-browser" not in sys.argv:
        threading.Thread(target=open_browser_later, args=(port,), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
