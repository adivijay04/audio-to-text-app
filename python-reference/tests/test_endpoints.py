"""Unit tests. Run:  pytest -q"""
import io
import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_transcribe_rejects_wrong_content_type():
    r = client.post(
        "/api/transcribe",
        files={"audio": ("x.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 400


def test_transcribe_rejects_empty():
    r = client.post(
        "/api/transcribe",
        files={"audio": ("x.wav", b"", "audio/wav")},
    )
    assert r.status_code == 400


def test_transcribe_rejects_oversized(monkeypatch):
    big = io.BytesIO(b"\x00" * (25 * 1024 * 1024))
    r = client.post(
        "/api/transcribe",
        files={"audio": ("x.wav", big, "audio/wav")},
    )
    assert r.status_code == 413


def test_tts_validates_length():
    r = client.post("/api/tts", json={"text": ""})
    assert r.status_code == 422  # pydantic min_length
    r = client.post("/api/tts", json={"text": "x" * 5000})
    assert r.status_code == 422
