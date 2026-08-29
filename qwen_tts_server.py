#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qwen_tts_server.py —— 「好好睡觉」GPU 服务器统一服务（AutoDL 部署）

模型：Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign（音色由自然语言 instruct 设计）

接口（与前端 tc-tts.js / PROXY 配置完全匹配）：
  GET  /health               健康检查 {"ok":true,"model_loaded":true}
  GET  /tts?text=&voice=&speed=   语音合成，返回 audio/wav 字节
       voice: 音色 id（101001 等，见 VOICE_INSTRUCTS）；speed: -2..6，0 为常速
  POST /v1/chat/completions  DeepSeek 对话代理（门禁 key 见 GATE_KEY）
       兼容两种鉴权：body.key 或请求头 apikey（前端 index/caignick/app 各用其一）

部署（AutoDL 实例上）：
  pip install fastapi uvicorn qwen-tts soundfile requests
  DEEPSEEK_API_KEY=sk-xxx PORT=8000 python3 qwen_tts_server.py
  # PORT 需与 nginx upstream 一致（若原服务在 6006，则 PORT=6006）

启动时即加载模型（TTS 首次请求无冷启动延迟），并做一次预热合成。
"""
import io
import json
import os
import threading

import requests
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response

# ================= 配置 =================
PORT = int(os.environ.get("PORT", "8000"))
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
GATE_KEY = os.environ.get("GATE_KEY", "sleep-2026")   # 前端 anon key 门禁
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
MAX_TEXT = 600          # 单次合成上限（前端已按 ≤200 字分句，此处兜底）

# 音色 id → VoiceDesign instruct（与前端 tc-tts.js VOICES 一一对应）
VOICE_INSTRUCTS = {
    101001: "30岁左右的温柔女声，语速缓慢平稳，音色柔和温暖，气息绵长轻柔，"
            "像轻声细语的睡前陪伴者，适合助眠引导",
    101002: "25岁左右的自然女声，语速适中，吐字清晰，音色干净自然，亲切平和",
    101003: "20岁左右的甜美女声，语速轻缓，音色甜美柔和带一点气声，温柔治愈",
    101004: "30岁左右的平和男声，语速适中偏慢，音色低沉干净，平稳自然",
    101017: "40岁左右的沉稳男声，语速缓慢，音色浑厚低沉，安定厚重，令人放松",
}
DEFAULT_INSTRUCT = VOICE_INSTRUCTS[101001]

app = FastAPI(title="luoding-qwen-tts", version="1.0")

# ================= 模型加载（启动时） =================
_model = None
_model_lock = threading.Lock()   # GPU 串行合成，避免并发显存溢出
_load_error = ""


def get_model():
    global _model, _load_error
    if _model is not None:
        return _model
    try:
        from qwen_tts import Qwen3TTSModel
        _model = Qwen3TTSModel.from_pretrained(MODEL_ID, device_map="cuda:0")
    except Exception as e:  # noqa: BLE001
        _load_error = f"{type(e).__name__}: {e}"
        raise
    return _model


def speed_to_ratio(speed: float) -> float:
    """前端 speed（腾讯风格 -2..6，0=常速，负值更慢）→ Qwen3-TTS speed 倍率"""
    return max(0.5, min(2.2, 1.0 + speed * 0.2))


def synth_wav(text: str, voice_id: int, speed: float) -> bytes:
    model = get_model()
    text = (text or "").strip()[:MAX_TEXT]
    if not text:
        raise ValueError("text 不能为空")
    instruct = VOICE_INSTRUCTS.get(int(voice_id), DEFAULT_INSTRUCT)
    ratio = speed_to_ratio(float(speed))
    with _model_lock:  # 单 GPU 串行
        try:
            wavs, sr = model.generate_voice_design(
                text=text, language="Chinese", instruct=instruct, speed=ratio)
        except TypeError:  # 旧版 qwen-tts 不支持 speed 参数
            wavs, sr = model.generate_voice_design(
                text=text, language="Chinese", instruct=instruct)
    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ================= 路由 =================
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
}


@app.get("/health")
async def health():
    return JSONResponse(
        {"ok": True, "model_loaded": _model is not None, "error": _load_error},
        headers=CORS_HEADERS)


@app.options("/tts")
@app.options("/v1/chat/completions")
async def preflight():
    return Response(status_code=204, headers=CORS_HEADERS)


@app.get("/tts")
def tts(text: str = Query(...), voice: int = Query(101001),
        speed: float = Query(0)):
    try:
        wav = synth_wav(text, voice, speed)
        return Response(content=wav, media_type="audio/wav", headers=CORS_HEADERS)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"error": {"message": f"TTS 合成失败: {type(e).__name__}: {e}"}},
            status_code=500, headers=CORS_HEADERS)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    raw = await request.body()
    # 门禁：兼容 body.key（index/caignick）与 apikey 请求头（app/本地中继）两种前端用法
    gate_ok = False
    try:
        body = json.loads(raw)
        if isinstance(body, dict) and body.get("key") == GATE_KEY:
            gate_ok = True
            body.pop("key", None)
            raw = json.dumps(body).encode()
    except (json.JSONDecodeError, UnicodeDecodeError):
        body = None
    if request.headers.get("apikey") == GATE_KEY:
        gate_ok = True
    if not gate_ok:
        return JSONResponse({"error": {"message": "apikey 校验失败"}},
                            status_code=403, headers=CORS_HEADERS)
    if not DEEPSEEK_KEY:
        return JSONResponse({"error": {"message": "服务端未配置 DEEPSEEK_API_KEY"}},
                            status_code=500, headers=CORS_HEADERS)
    try:
        resp = requests.post(
            DEEPSEEK_URL, data=raw, timeout=(10, 120),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + DEEPSEEK_KEY})
        return Response(content=resp.content, status_code=resp.status_code,
                        media_type=resp.headers.get("Content-Type", "application/json"),
                        headers=CORS_HEADERS)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"error": {"message": f"中继连接 DeepSeek 失败: {e}"}},
            status_code=502, headers=CORS_HEADERS)


# ================= 启动 =================
@app.on_event("startup")
def startup():
    try:
        get_model()
        with _model_lock:
            model = get_model()
            wavs, sr = model.generate_voice_design(
                text="准备就绪", language="Chinese", instruct=DEFAULT_INSTRUCT)
            sf.write(io.BytesIO(), wavs[0], sr)  # 预热一次推理
        print(f"[startup] {MODEL_ID} 已加载并预热")
    except Exception as e:  # noqa: BLE001
        print(f"[startup] 模型加载失败，将在首个请求重试: {e}")


if __name__ == "__main__":
    print(f"luoding-qwen-tts 启动: 0.0.0.0:{PORT}")
    print(f"  GET  /health / /tts?text=&voice=&speed=   (Qwen3-TTS-VoiceDesign)")
    print(f"  POST /v1/chat/completions                (DeepSeek 代理, 门禁: {GATE_KEY})")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
