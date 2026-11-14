"""Local streaming command recognition. Audio is processed in memory."""
import json
import os
from functools import lru_cache
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel


MODEL_DIR = Path(os.getenv("INBOUND_VOICE_MODEL", Path(__file__).resolve().parent.parent / "runtime/models/vosk-model-small-en-us-0.15"))
COMMANDS = {"start": "start", "start recording": "start", "snap": "snap", "stop": "stop", "stop recording": "stop"}


@lru_cache(maxsize=1)
def model():
    if not (MODEL_DIR / "am/final.mdl").exists():
        raise ValueError("Local voice model is missing. Run .venv/bin/python scripts/setup_voice.py.")
    SetLogLevel(-1)
    return Model(str(MODEL_DIR))


def recognizer():
    # Full vocabulary avoids forcing ordinary speech into a command grammar.
    result = KaldiRecognizer(model(), 16000)
    result.SetWords(True)
    return result


def accept(recognizer, pcm: bytes) -> dict | None:
    if not recognizer.AcceptWaveform(pcm):
        return None
    result = json.loads(recognizer.Result())
    text = result.get("text", "").strip().lower()
    command = COMMANDS.get(text)
    words = result.get("result", [])
    if command and words and min(word.get("conf", 0) for word in words) < 0.65:
        command = None
    return {"heard": text, "command": command, "end": words[-1]["end"] if words else None}
