# VoiceBridge — Python Reference Backend (FastAPI)

This folder is a **teaching companion** to the live TypeScript app deployed
from this repo. It re-implements the same backend in **Python + FastAPI**
so you can read, run, and modify the flow in a language you already
follow. The live web app in `src/` calls a TS backend (because this
platform runs on Cloudflare Workers, which don't execute Python), but the
architecture, contracts, and AI-model calls are **identical**.

---

## 1. Use case

A web application that helps **disabled users** consume and produce audio:

- **Deaf / hard-of-hearing** users → live captions from a microphone and
  transcripts from uploaded audio files.
- **Vision-impaired users** → text-to-speech read-aloud of any transcript.
- **Motor-impaired users** → large tap targets, full keyboard operation,
  ARIA live regions announcing state changes.

---

## 2. Standard SDLC steps followed

| Phase | What we did |
|---|---|
| **1. Requirements** | Interviewed the user (that's you) via clarifying questions. Locked scope: mic → live captions, file upload → transcript, TTS read-aloud. |
| **2. Analysis** | Identified 3 API contracts (`/transcribe`, `/tts`, static UI), 2 external services (OpenAI STT + TTS via Lovable AI Gateway), accessibility constraints (WCAG AA), and non-functional needs (streaming latency, 24 MB file cap). |
| **3. Design** | Chose a **thin server / rich client** architecture. Server = proxy to AI Gateway (keeps API key secret + centralizes auth/limits). Client = accessible React SPA with Web Audio API. See §4. |
| **4. Implementation** | TS backend in `src/routes/api/` (live app); mirror Python backend in this folder. |
| **5. Testing** | Manual end-to-end smoke test + unit-testable pure functions (`encodeWav`, SSE parser). Add `pytest` for the Python version — sample in `tests/`. |
| **6. Deployment** | Live app: auto-deployed on Lovable. Python version: `uvicorn app.main:app`, deploy to Fly.io / Railway / any Docker host. |
| **7. Maintenance** | Structured logs on every gateway call, versioned model IDs, `.env`-based secret rotation. |

---

## 3. High-level architecture

```text
 ┌────────────────────────┐        HTTPS / SSE        ┌───────────────────┐
 │  Browser (React SPA)   │  ───────────────────────► │   Your Backend    │
 │                        │                            │  (FastAPI /       │
 │  • MediaRecorder / Web │  ◄─────────────────────── │   TanStack)       │
 │    Audio API           │      SSE deltas            │                   │
 │  • PCM playback        │                            │  • Auth (optional)│
 │  • ARIA live regions   │                            │  • Rate limit     │
 └────────────────────────┘                            │  • Input validate │
                                                       │  • Forward to AI  │
                                                       └────────┬──────────┘
                                                                │
                                                    HTTPS + Bearer key
                                                                ▼
                                              ┌──────────────────────────────┐
                                              │   Lovable AI Gateway         │
                                              │   (OpenAI-compatible proxy)  │
                                              │                              │
                                              │  • openai/gpt-4o-transcribe  │
                                              │  • openai/gpt-4o-mini-tts    │
                                              └──────────────────────────────┘
```

**Why a backend proxy at all?** The AI provider key MUST NEVER live in the
browser — anyone could copy it from DevTools and run up your bill. The
backend is a thin, security-focused layer that (a) hides the key,
(b) validates file size/content, and (c) can add rate limits or user auth
later without changing the client.

**Why Server-Sent Events (SSE)?** Both STT and TTS support streaming.
For a deaf user reading captions, seeing words appear as they're
recognized (~200 ms lag) feels dramatically better than waiting 5 seconds
for the full transcript.

---

## 4. Component design

**Backend endpoints**

| Method | Path | Body | Response | Purpose |
|---|---|---|---|---|
| POST | `/api/transcribe` | multipart with `audio` file | SSE stream of `transcript.text.delta` events | Turn audio → text |
| POST | `/api/tts` | JSON `{text, voice}` | SSE stream of `speech.audio.delta` events (base64 PCM) | Turn text → audio |

**Frontend modules** (mirrored in `src/lib/audio.ts` on the TS side)

- `encode_wav(chunks, sample_rate)` — pure function: PCM Float32 → 16 kHz
  mono WAV blob. Downsampling keeps uploads small.
- `PcmPlayer` — Web Audio scheduler that plays incoming PCM chunks
  gap-free.
- `read_sse(response, callback)` — small SSE line parser (avoids adding
  a dep for a 20-line function).

---

## 5. How to run the Python reference locally

```bash
cd python-reference
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export LOVABLE_API_KEY="sk-..."   # copy from your Lovable project settings
uvicorn app.main:app --reload --port 8000
```

Then open `http://localhost:8000` — the FastAPI app also serves the
minimal HTML client at `app/static/index.html` so you can exercise the
whole flow.

---

## 6. Security checklist

- [x] API key server-side only (`os.environ`, never sent to browser)
- [x] File size cap enforced before buffering (`MAX_AUDIO_BYTES = 24 MB`)
- [x] Explicit MIME allowlist on uploads
- [x] Text length cap on `/tts` (4000 chars) to prevent runaway bills
- [x] CORS locked to same-origin by default (edit `ALLOWED_ORIGINS`)
- [x] Structured error responses that don't leak the upstream key
- [ ] Optional: add user auth + per-user quotas before public launch
- [ ] Optional: HMAC-signed short-lived tokens if you split frontend/backend hosts

---

## 7. Testing strategy

Unit tests live in `tests/`. Run `pytest`.

- `test_endpoints.py` — hits `/api/transcribe` and `/api/tts` with a
  monkeypatched `httpx` client so no real API calls happen.
- `test_validation.py` — asserts oversized files return 413, empty
  bodies return 400, missing model returns 400.
- Manual browser smoke test: record → verify captions appear
  incrementally → "Read aloud" → hear the transcript.

---

## 8. Where to look next

- `app/main.py`         — FastAPI app + endpoint definitions (~120 lines)
- `app/gateway.py`      — thin async client for Lovable AI Gateway
- `app/static/index.html` — vanilla-JS accessible client (mirror of the React one)
- `tests/`              — pytest suite
- `Dockerfile`          — production container
