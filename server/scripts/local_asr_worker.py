"""Offline Mandarin speech recognition worker; one JSON request per line."""

import base64
import io
import json
import sys
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "ml" / "models" / "asr"
MAX_SECONDS = 20


def decode_wav(payload):
    data = base64.b64decode(payload, validate=True)
    with wave.open(io.BytesIO(data), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
            raise ValueError("expected mono 16-bit 16-kHz WAV")
        frames = wav.getnframes()
        if frames < 3200 or frames > MAX_SECONDS * 16000:
            raise ValueError("recording duration is invalid")
        samples = np.frombuffer(wav.readframes(frames), dtype="<i2").astype(np.float32) / 32768.0
    if float(np.sqrt(np.mean(samples * samples))) < 0.002:
        raise ValueError("no speech detected")
    return samples


def main():
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(MODEL_DIR / "model.int8.onnx"),
        tokens=str(MODEL_DIR / "tokens.txt"),
        num_threads=2,
        language="zh",
        use_itn=True,
    )
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            samples = decode_wav(request["audio"])
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, samples)
            recognizer.decode_stream(stream)
            transcript = stream.result.text.strip()
            if not transcript:
                raise ValueError("no speech recognized")
            response = {"id": request["id"], "text": transcript[:1000]}
        except ValueError:
            response = {"id": request.get("id") if isinstance(request, dict) else None, "error": "no_speech"}
        except Exception:
            response = {"id": request.get("id") if isinstance(request, dict) else None, "error": "recognition_failed"}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
