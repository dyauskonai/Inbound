import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

from openai import APIConnectionError, AuthenticationError, RateLimitError

from . import ai, media


log = logging.getLogger(__name__)
SNAP_WORDS = {"snap", "snapshot", "screenshot"}
VITAL_NAMES = {"bp": "blood pressure", "hr": "heart rate", "spo2": "oxygen saturation", "rr": "respiratory rate"}
VITAL_FIELDS = {"bp": "blood_pressure", "hr": "heart_rate", "spo2": "spo2", "rr": "respiratory_rate"}


def shown(kind: str, value: str) -> str:
    return f"{value}%" if kind == "spo2" and value.isdigit() else value


def vital_evidence(vital: dict) -> dict:
    """What the phone heard and the medic confirmed, as report evidence."""
    name, value = VITAL_NAMES[vital["kind"]], shown(vital["kind"], vital["value"])
    heard = " then ".join(shown(vital["kind"], item) for item in vital["candidates"])
    text = {
        "heard": f"Inbound heard the medic report {name} {value}.",
        "conflict": f"Inbound heard two different {name} values close together ({heard}) and asked the medic to repeat it.",
        "confirmed": f"Asked to repeat the {name} after hearing {heard}, the medic said {value}. This is the confirmed value.",
        "unconfirmed": f"The medic did not repeat the {name} when asked. It is unconfirmed: Inbound heard {heard}.",
    }[vital["status"]]
    return {"id": f"vital_{vital['seq']}", "kind": "vital", "start": vital["seconds"], "end": vital["seconds"],
            "vital": vital["kind"], "status": vital["status"], "text": text}


def apply_vitals(report: dict, vitals: list[dict]) -> None:
    """The medic's spoken confirmations decide the handoff card's vitals, not the model."""
    handoff = report.get("handoff")
    if not handoff:
        return
    confirmed, unconfirmed = [], []
    for kind, field in VITAL_FIELDS.items():
        events = [vital for vital in vitals if vital["kind"] == kind]
        settled = [index for index, vital in enumerate(events) if vital["status"] != "heard"]
        if not settled:
            continue
        last = events[settled[-1]]
        # A different value reported afterwards is a new reading; the model weighs it from the evidence.
        if any(vital["value"] != last["value"] for vital in events[settled[-1] + 1:]):
            continue
        if last["status"] == "confirmed":
            handoff[field] = shown(kind, last["value"])
            confirmed.append(field)
        else:
            handoff[field] = " or ".join(shown(kind, value) for value in last["candidates"]) + " (unconfirmed)"
            unconfirmed.append(field)
            report["uncertainties"].insert(0, f"The {VITAL_NAMES[kind]} is unconfirmed: the medic gave "
                                              f"{' and '.join(shown(kind, value) for value in last['candidates'])} and did not repeat it when asked.")
        handoff["evidence_ids"] = [*dict.fromkeys([*handoff["evidence_ids"], f"vital_{last['seq']}"])]
    handoff["missing_fields"] = [field for field in handoff["missing_fields"] if field not in confirmed + unconfirmed]
    handoff["confirmed_fields"] = confirmed
    handoff["unconfirmed_fields"] = unconfirmed


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
            vitals = session.get("vitals", [])
            evidence.extend(transcript + notes + [vital_evidence(vital) for vital in vitals])
            transcript = transcript or notes
            self.store.update(session_id, transcript=transcript, evidence=evidence, progress="Writing report from source evidence")
            report = ai.generate_report(directory, evidence)
            if not info["has_audio"]:
                report["uncertainties"].insert(0, "No audio reached the Mac. The report uses the phone's on-device transcript and photos."
                                               if transcript else "This recording has no audio track. The report covers images only.")
            report["uncertainties"][:0] = corrections
            apply_vitals(report, vitals)
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
