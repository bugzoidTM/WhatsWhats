import base64
import os
import tempfile
import subprocess
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from faster_whisper import WhisperModel

app = FastAPI(title="Local Whisper STT", version="1.0.0")

class TranscribeRequest(BaseModel):
    audio_base64: str
    mimetype: str | None = None
    filename: str | None = None
    language: str | None = "pt"

@lru_cache(maxsize=1)
def get_model():
    model_name = os.getenv("WHISPER_MODEL", "small")
    device = os.getenv("WHISPER_DEVICE", "cpu")
    compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
    return WhisperModel(model_name, device=device, compute_type=compute_type)

def run_ffmpeg(input_path: str, output_path: str):
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", input_path,
        "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", output_path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    if result.returncode != 0:
        raise HTTPException(status_code=400, detail=f"ffmpeg falhou: {result.stderr[-500:]}")

@app.get("/health")
def health():
    return {"ok": True, "model": os.getenv("WHISPER_MODEL", "small")}

@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    if not req.audio_base64:
        raise HTTPException(status_code=400, detail="audio_base64 vazio")
    try:
        raw = base64.b64decode(req.audio_base64, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"base64 inválido: {exc}")
    if len(raw) < 200:
        raise HTTPException(status_code=400, detail="áudio muito pequeno")
    if len(raw) > int(os.getenv("MAX_AUDIO_BYTES", "25000000")):
        raise HTTPException(status_code=413, detail="áudio excede limite local")

    suffix = ".ogg"
    mt = (req.mimetype or "").lower()
    fn = (req.filename or "").lower()
    if "mpeg" in mt or fn.endswith(".mp3"):
        suffix = ".mp3"
    elif "mp4" in mt or fn.endswith(".m4a"):
        suffix = ".m4a"
    elif "wav" in mt or fn.endswith(".wav"):
        suffix = ".wav"

    with tempfile.TemporaryDirectory() as td:
        input_path = os.path.join(td, "input" + suffix)
        wav_path = os.path.join(td, "audio.wav")
        with open(input_path, "wb") as f:
            f.write(raw)
        run_ffmpeg(input_path, wav_path)
        segments, info = get_model().transcribe(
            wav_path,
            language=req.language or "pt",
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        parts = [s.text.strip() for s in segments if s.text and s.text.strip()]
        text = " ".join(parts).strip()
        return {
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
        }
