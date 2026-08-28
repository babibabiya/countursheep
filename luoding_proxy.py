#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
luoding_proxy.py —— 「好好睡觉」本地中继（Python 版）

作用：在浏览器与微软 Edge 语音 / DeepSeek 之间做一层服务端转发。
  1) POST /tts             自然语音合成（微软 Edge 神经网络音色）
     请求体: { "text": "...", "voice": "zh-CN-XiaoxiaoNeural", "rate": -15 }
     返回:   audio/mpeg
  2) POST /chat/completions DeepSeek 对话代理（key 只存服务端）
     请求体: 与 DeepSeek Chat Completions 一致；门禁：请求头 apikey == GATE_KEY
  3) GET  /...              同目录静态文件服务（可选）

为什么必须走中继：微软 Edge 语音握手要求携带 Cookie: muid=<随机值>，
浏览器内 JS 的 WebSocket 无法自定义 Cookie 头，只能由服务端完成握手。

依赖：pip install edge-tts
运行：python3 luoding_proxy.py
"""
import json
import os
import re
import sys
import asyncio
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8418"))
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "sk-069baa049ed24bb2972699d84184ac13")
GATE_KEY = os.environ.get("GATE_KEY", "local")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"

try:
    import edge_tts
except ImportError:
    print("缺少依赖 edge-tts，请先执行：pip install edge-tts")
    sys.exit(1)

VOICE_RE = re.compile(r"^[\w-]+$")


def synth_audio(text: str, voice: str, rate: int) -> bytes:
    async def _run() -> bytes:
        rate_str = f"{rate:+d}%" if rate else "+0%"
        communicate = edge_tts.Communicate(text, voice, rate=rate_str)
        audio = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio":
                audio.extend(chunk["data"])
        return bytes(audio)
    return asyncio.run(_run())


def proxy_deepseek(body: bytes) -> tuple:
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + DEEPSEEK_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "application/json")
            return resp.status, ctype, data
    except urllib.error.HTTPError as e:
        data = e.read()
        ctype = e.headers.get("Content-Type", "application/json") if e.headers else "application/json"
        return e.code, ctype, data
    except Exception as e:  # noqa: BLE001
        return 502, "application/json", json.dumps({"error": {"message": f"中继连接 DeepSeek 失败: {e}"}}).encode()


MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
}

HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(BaseHTTPRequestHandler):
    server_version = "luoding-proxy/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, apikey, Authorization")

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else b""

        if path == "/tts":
            try:
                params = json.loads(body.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                params = {}
            text = str(params.get("text", "")).strip()
            voice = params.get("voice", "zh-CN-XiaoxiaoNeural")
            if not VOICE_RE.match(str(voice)):
                voice = "zh-CN-XiaoxiaoNeural"
            try:
                rate = max(-50, min(100, int(params.get("rate", 0) or 0)))
            except (TypeError, ValueError):
                rate = 0
            if not text:
                return self._json(400, {"error": "text 不能为空"})
            try:
                audio = synth_audio(text, voice, rate)
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": f"Edge TTS 失败: {e}"})
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self._cors()
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
            return

        if path == "/chat/completions":
            if self.headers.get("apikey") != GATE_KEY:
                return self._json(403, {"error": {"message": "apikey 校验失败"}})
            status, ctype, data = proxy_deepseek(body)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self._cors()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._json(404, {"error": "Not Found"})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        filepath = os.path.normpath(os.path.join(HERE, path.lstrip("/")))
        if not filepath.startswith(HERE):
            self._json(403, {"error": "Forbidden"})
            return
        if not os.path.isfile(filepath):
            self._json(404, {"error": "Not Found"})
            return
        ext = os.path.splitext(filepath)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(filepath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"luoding-proxy 已启动: http://127.0.0.1:{PORT}/")
    print("  POST /tts              自然语音合成（Edge 神经网络音色）")
    print(f"  POST /chat/completions DeepSeek 代理（apikey 门禁: {GATE_KEY}）")
    print("  GET  /                 静态站点服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
