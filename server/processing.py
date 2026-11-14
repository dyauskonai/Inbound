import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

from openai import APIConnectionError, AuthenticationError, RateLimitError

from . import ai, media


log = logging.getLogger(__name__)
SNAP_WORDS = {"snap", "snapshot", "screenshot"}


def restore_snaps(transcript: list[dict], notes: list[dict]) -> list[str]:
    """Undo cloud transcription that turned the "snap" command into a clinical word.

    The phone acted on "snap", so its line is ground truth for that word. In context the
    cloud model heard "snap the left forearm" as "splinted the left forearm". Where the
    cloud transcript has another word before the phrase that followed "snap", put "snap"
    back. Returns a description of each correction for the report's uncertainties.
    """
    corrections = []
    for note in notes:
        words = re.findall(r"[a-z0-9']+", note["text"].lower())
        for index, word in enumerate(words):
            anchor = words[index + 1:index + 4]
            if word not in SNAP_WORDS or len(anchor) < 2:
                continue
            pattern = re.compile(r"\b([A-Za-z'-]+)(\W+" + r"\W+".join(map(re.escape, anchor)) + r")\b", re.IGNORECASE)
            for entry in transcript:
                match = pattern.search(entry["text"])
                if match and match[1].lower() not in SNAP_WORDS:
                    entry["text"] = entry["text"][:match.start()] + "snap" + match[2] + entry["text"][match.end():]
                    corrections.append(f'The audio transcript heard "{match[1]}" where the phone recognized the "snap" '
                                       f'command before "{" ".join(anchor)}". It is treated as the command, not an action.')
                    break
    return corrections


class Processor:
    def __init__(self, store):
        self.store = store
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="inbound-media")
        self.lock = Lock()
        self.active = set()

    def submit(self, session_id: str) -> bool:
        with self.lock:
            if session_id in self.active or self.store.get(session_id)["status"] == "complete":
                return False
            self.active.add(session_id)
            self.store.update(session_id, status="processing", progress="Preparing recording", error=None)
        self.pool.submit(self.run, session_id)
        return True

    def run(self, session_id: str):
        try:
            session = self.store.get(session_id)
            directory = self.store.media_dir(session_id)
            if session["has_video"]:
                info, evidence = media.prepare(directory, session["bookmarks"], glasses=session["source"] == "glasses")
                source = "original"
            else:
                # Glasses captures arrive from the phone as audio parts, photos, and transcript lines.
                info, evidence = media.prepare_phone(directory, session)
                source = "recording.wav"
            # The phone's on-device transcript stands in when there is no audio or no API key.
            notes = [{"id": f"note_{note['seq']}", "kind": "transcript", "start": note["seconds"], "end": note["seconds"],
                      "text": note["text"], "source": "phone"} for note in session.get("notes", [])]
            self.store.update(session_id, **info, evidence=evidence, transcript=notes, progress="Recording and photos ready")
            if not os.getenv("OPENAI_API_KEY"):
                self.store.update(session_id, status="awaiting_key", progress="Add OPENAI_API_KEY to .env, restart the server, then retry.")
                return
            transcript = []
            if info["has_audio"]:
                for index, (path, start, end) in enumerate(media.audio_chunks(directory, info["duration"], source)):
                    self.store.update(session_id, progress=f"Transcribing {int(start)}–{int(end)} seconds")
                    try:
                        text = ai.transcribe(path)
                    finally:
                        path.unlink(missing_ok=True)
                    if text:
                        transcript.append({"id": f"audio_{index}", "kind": "transcript", "start": start, "end": end, "text": text})
            corrections = restore_snaps(transcript, notes)
            if not transcript and not evidence and not notes:
                raise ValueError("No audio, transcript, or photos reached the Mac for this capture.")
            # The phone's lines go in too: they show the exact control words the phone acted on,
            # which the cloud transcript can mishear in context ("snap" became "splint").
            evidence.extend(transcript + notes)
            transcript = transcript or notes
            self.store.update(session_id, transcript=transcript, evidence=evidence, progress="Writing report from source evidence")
            report = ai.generate_report(directory, evidence)
            if not info["has_audio"]:
                report["uncertainties"].insert(0, "No audio reached the Mac. The report uses the phone's on-device transcript and photos."
                                               if transcript else "This recording has no audio track. The report covers images only.")
            report["uncertainties"][:0] = corrections
            missing = [kind for kind, expected, received in [
                ("audio parts", session.get("expected_audio_parts", 0), len(session.get("audio_parts", {}))),
                ("photos", session.get("expected_photos", 0), len(session.get("photos", []))),
            ] if received < expected]
            if missing:
                report["uncertainties"].insert(0, f"Some {' and '.join(missing)} did not reach the Mac. Parts of the capture may be missing.")
            self.store.update(session_id, status="complete", report=report, progress="Report ready")
        except AuthenticationError:
            self.fail(session_id, "OpenAI rejected the API key. Update .env, restart, and retry.")
        except RateLimitError:
            self.fail(session_id, "OpenAI rate or billing limit reached. Check your account and retry.")
        except APIConnectionError:
            self.fail(session_id, "Could not reach OpenAI. Your recording is saved. Check the connection and retry.")
        except Exception as error:
            log.exception("Session %s processing failed", session_id)
            message = str(error) if isinstance(error, ValueError) else "Processing failed. Your recording is saved. Check the server log and retry."
            self.fail(session_id, message)
        finally:
            with self.lock:
                self.active.discard(session_id)

    def fail(self, session_id, message):
        self.store.update(session_id, status="failed", error=message, progress="Needs attention")
