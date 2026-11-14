"""Download the Vosk small English model for local voice commands."""
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "runtime/models"
URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"

if __name__ == "__main__":
    DEST.mkdir(parents=True, exist_ok=True)
    target = DEST / "vosk-model-small-en-us-0.15"
    if (target / "am/final.mdl").exists():
        print("Local English commands are already installed.")
    else:
        archive = DEST / "english.zip"
        print("Downloading the English command model…")
        urllib.request.urlretrieve(URL, archive)
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                resolved = (DEST / item.filename).resolve()
                if not resolved.is_relative_to(DEST.resolve()):
                    raise ValueError("Unsafe archive path")
            source.extractall(DEST)
        archive.unlink()
        print("Local English commands are ready.")
