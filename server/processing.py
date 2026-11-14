import logging
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

from openai import APIConnectionError, AuthenticationError, RateLimitError

from . import ai, media


log = logging.getLogger(__name__)


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
            info, evidence = media.prepare(directory, session["bookmarks"], glasses=session["source"] == "glasses")
            self.store.update(session_id, **info, evidence=evidence, progress="Recording and snaps ready")
            if not os.getenv("OPENAI_API_KEY"):
                self.store.update(session_id, status="awaiting_key", progress="Add OPENAI_API_KEY to .env, restart the server, then retry.")
                return
            transcript = []
            if info["has_audio"]:
                for index, (path, start, end) in enumerate(media.audio_chunks(directory, info["duration"])):
                    self.store.update(session_id, progress=f"Transcribing {int(start)}–{int(end)} seconds")
                    try:
                        text = ai.transcribe(path)
                    finally:
                        path.unlink(missing_ok=True)
                    if text:
                        transcript.append({"id": f"audio_{index}", "kind": "transcript", "start": start, "end": end, "text": text})
            evidence.extend(transcript)
            self.store.update(session_id, transcript=transcript, evidence=evidence, progress="Writing report from source evidence")
            report = ai.generate_report(directory, evidence)
            if not info["has_audio"]:
                report["uncertainties"].insert(0, "This recording has no audio track. The report covers sampled images only.")
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
