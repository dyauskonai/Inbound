"""Local streaming command recognition. Audio is processed in memory."""
import json
import os
from functools import lru_cache
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel


MODEL_DIR = Path(os.getenv("INBOUND_VOICE_MODEL", Path(__file__).resolve().parent.parent / "runtime/models/vosk-model-small-en-us-0.15"))
COMMANDS = {"start": "start", "stop": "stop", "snap": "snap", "snapshot": "snap", "screenshot": "snap"}
# "Don't stop" must not end a recording.
NEGATIONS = {"don't", "dont", "not", "never", "cannot", "can't", "won't"}


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
    words = result.get("result", [])
    # Command words count anywhere in a sentence, each with the time it was said.
    commands = [{"command": COMMANDS[word["word"]], "end": word.get("end")} for index, word in enumerate(words)
                if word.get("word") in COMMANDS and word.get("conf", 0) >= 0.65
                and (index == 0 or words[index - 1].get("word") not in NEGATIONS)]
    return {"heard": text, "commands": commands, "end": words[-1]["end"] if words else None}
