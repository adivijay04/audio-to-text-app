"""
FastAPI reference backend for VoiceBridge.

Two endpoints:
  POST /api/transcribe  — multipart audio file → SSE transcript deltas
  POST /api/tts         — JSON {text, voice} → SSE base64 PCM deltas

Both proxy Lovable AI Gateway (OpenAI-compatible) with the server-side
LOVABLE_API_KEY. The client never sees the key.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# --- config ------------------------------------------------------------------

GATEWAY_BASE = "https://ai.gateway.lovable.dev/v1"
MAX_AUDIO_BYTES = 24 * 1024 * 1024  # 24 MB
MAX_TEXT_CHARS = 4000
ALLOWED_MIME_PREFIX = "audio/"
DEFAULT_STT_MODEL = "openai/gpt-4o-transcribe"        # accuracy for a11y
DEFAULT_TTS_MODEL = "openai/gpt-4o-mini-tts"
ALLOWED_ORIGINS = ["*"]  # tighten in production

app = FastAPI(title="VoiceBridge Python Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def _api_key() -> str:
    key = os.environ.get("LOVABLE_API_KEY")
    if not key:
        raise HTTPException(500, "LOVABLE_API_KEY not configured")
    return key


# --- /api/transcribe ---------------------------------------------------------

@app.post("/api/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    model: str = Form(DEFAULT_STT_MODEL),
) -> StreamingResponse:
    if not audio.content_type or not audio.content_type.startswith(ALLOWED_MIME_PREFIX):
        raise HTTPException(400, "audio/* content-type required")

    data = await audio.read()
    if not data:
        raise HTTPException(400, "empty file")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "file too large (max 24 MB)")

    async def upstream() -> AsyncIterator[bytes]:
        files = {"file": (audio.filename or "recording.wav", data, audio.content_type)}
        payload = {"model": model, "stream": "true"}
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{GATEWAY_BASE}/audio/transcriptions",
                headers={"Authorization": f"Bearer {_api_key()}"},
                files=files,
                data=payload,
            ) as r:
                if r.status_code >= 400:
                    body = await r.aread()
                    raise HTTPException(r.status_code, body.decode(errors="replace"))
                async for chunk in r.aiter_raw():
                    yield chunk

    return StreamingResponse(upstream(), media_type="text/event-stream")


# --- /api/tts ----------------------------------------------------------------

class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice: str = "alloy"


@app.post("/api/tts")
async def tts(body: TtsBody) -> StreamingResponse:
    async def upstream() -> AsyncIterator[bytes]:
        payload = {
            "model": DEFAULT_TTS_MODEL,
            "input": body.text,
            "voice": body.voice,
            "stream_format": "sse",
            "response_format": "pcm",
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{GATEWAY_BASE}/audio/speech",
                headers={
                    "Authorization": f"Bearer {_api_key()}",
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as r:
                if r.status_code >= 400:
                    detail = (await r.aread()).decode(errors="replace")
                    raise HTTPException(r.status_code, detail)
                async for chunk in r.aiter_raw():
                    yield chunk

    return StreamingResponse(upstream(), media_type="text/event-stream")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
