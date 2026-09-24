"""Offline Kokoro speech worker. One JSON request and one JSON response per line."""

import base64
import io
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from misaki import zh


ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "ml" / "models" / "tts"
MODEL = MODEL_DIR / "kokoro-v1.1-zh.fp16.onnx"
VOICES = MODEL_DIR / "voices-v1.1-zh.bin"
ALLOWED_VOICES = {"zf_001", "zf_002", "zm_009"}
MAX_CHARS = 180


def split_text(text, limit=70):
    sentences = re.split(r"(?<=[。！？!?；;，,])", text)
    chunks = []
    current = ""
    for sentence in sentences:
        while len(sentence) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(sentence[:limit])
            sentence = sentence[limit:]
        if len(current) + len(sentence) > limit:
            chunks.append(current)
            current = ""
        current += sentence
    if current:
        chunks.append(current)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def main():
    if not MODEL.is_file() or not VOICES.is_file():
        raise RuntimeError("offline voice model is not installed")
    # The v1.1 model uses its own Chinese phoneme alphabet. Legacy Misaki
    # emits IPA; its tokens are mostly absent from this model's vocabulary.
    g2p = zh.ZHG2P(version="1.1")
    kokoro = Kokoro(str(MODEL), str(VOICES))
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            text = str(request.get("text", "")).strip()
            voice = request.get("voice", "zf_001")
            if not text or len(text) > MAX_CHARS or voice not in ALLOWED_VOICES:
                raise ValueError("invalid voice request")
            segments = []
            sample_rate = 24000
            for chunk in split_text(text):
                phonemes, _ = g2p(chunk)
                if not phonemes:
                    continue
                samples, sample_rate = kokoro.create(
                    phonemes, voice=voice, speed=0.95, is_phonemes=True
                )
                if len(samples):
                    segments.append(samples)
                    segments.append(np.zeros(int(sample_rate * 0.16), dtype=np.float32))
            if not segments:
                raise ValueError("no speech generated")
            output = io.BytesIO()
            sf.write(output, np.concatenate(segments), sample_rate, format="WAV", subtype="PCM_16")
            response = {"id": request_id, "audio": base64.b64encode(output.getvalue()).decode("ascii")}
        except Exception:
            response = {"id": request.get("id") if isinstance(request, dict) else None, "error": "synthesis_failed"}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
