import hashlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .media import ffmpeg, prepare


def create_sample(store):
    session = store.create("Training handoff · forearm injury", "sample")
    directory = store.media_dir(session["id"])
    font_path = Path("/System/Library/Fonts/Helvetica.ttc")
    def font(size):
        return ImageFont.truetype(str(font_path), size) if font_path.exists() else ImageFont.load_default(size=size)
    scenes = [
        ("Arrival and assessment", "Patient reports left forearm pain after a fall.", "Age reported as 28. Awake and speaking."),
        ("Vital signs read-back", "Blood pressure corrected to 90 over 60.", "Heart rate reported as 110. SpO2 reported as 98%."),
        ("Handoff preparation", "No allergies reported by the volunteer.", "ETA reported as six minutes. Values await human review."),
    ]
    for index, (title, first, second) in enumerate(scenes):
        image = Image.new("RGB", (1280, 720), "#101f27")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((60, 60, 1220, 660), radius=24, outline="#38505b", width=2)
        draw.text((104, 102), "INBOUND  /  SCRIPTED TRAINING RECORDING", fill="#6ed8ba", font=font(22))
        draw.text((104, 230), title, fill="#f1f5f4", font=font(44))
        draw.text((104, 330), first, fill="#d4e1e0", font=font(27))
        draw.text((104, 385), second, fill="#d4e1e0", font=font(25))
        draw.text((104, 570), "Fictional scenario · Generated title cards · Sample report", fill="#9cb2bb", font=font(22))
        image.save(directory / f"scene{index}.png")
    ffmpeg("-framerate", "1/4", "-i", directory / "scene%d.png", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
           "-t", "12", "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", directory / "sample.mp4")
    (directory / "sample.mp4").replace(directory / "original")
    bookmarks = [{"id": "vitals", "seconds": 5.5, "label": "Vital signs correction"}, {"id": "handoff", "seconds": 9, "label": "Handoff preparation"}]
    info, evidence = prepare(directory, bookmarks)
    transcript = [
        {"id": "audio_0", "kind": "transcript", "start": 0, "end": 4, "text": "Scripted example: Patient is 28, awake and speaking, reporting left forearm pain after a fall."},
        {"id": "audio_1", "kind": "transcript", "start": 4, "end": 8, "text": "Scripted example: BP 190 over 90. Correction, 90 over 60. Heart rate 110. SpO2 98 percent."},
        {"id": "audio_2", "kind": "transcript", "start": 8, "end": 12, "text": "Scripted example: The volunteer reports no allergies. ETA six minutes."},
    ]
    report = {
        "title": "Forearm injury following a fall",
        "summary": [{"text": "In this fictional training handoff, a 28-year-old patient is reported awake and speaking, with left forearm pain following a fall.", "evidence_ids": ["audio_0"]},
                    {"text": "The scripted blood pressure is corrected from 190/90 to 90/60. Heart rate is reported as 110 and SpO2 as 98%.", "evidence_ids": ["audio_1"]}],
        "sections": [
            {"heading": "Reported presentation", "statements": [{"text": "The reported mechanism is a fall. The account identifies the left forearm as the painful area. Details of the fall and prior history are absent.", "evidence_ids": ["audio_0"]}]},
            {"heading": "Reported vital signs", "statements": [{"text": "Blood pressure is corrected to 90/60 in the script. Heart rate is 110 and SpO2 is 98%. These are fictional, unconfirmed reported values.", "evidence_ids": ["audio_1"]}]},
            {"heading": "Handoff details", "statements": [{"text": "The volunteer reports no allergies. An estimated arrival of six minutes is stated.", "evidence_ids": ["audio_2"]}]},
            {"heading": "Visual record", "statements": [{"text": "The marked frame displays a generated training card describing the vital-sign correction.", "evidence_ids": ["snap_vitals"]}]},
        ],
        "timeline": [{"seconds": 0, "title": "Initial account", "detail": "Age, symptoms, and mechanism are reported.", "evidence_ids": ["audio_0"]},
                     {"seconds": 4, "title": "Correction retained", "detail": "Both the original and corrected blood pressure appear in the scripted transcript.", "evidence_ids": ["audio_1", "snap_vitals"]},
                     {"seconds": 8, "title": "Handoff details", "detail": "Allergy report and ETA are included.", "evidence_ids": ["audio_2", "snap_handoff"]}],
        "uncertainties": ["This is a fixed sample report and transcript. AI did not generate this example.", "The sample video contains generated title cards and a silent audio track.", "Actual recordings require an OpenAI API key for transcription and report generation."],
    }
    return store.update(session["id"], **info, status="complete", progress="Sample report ready", has_video=True,
                        video_hash=hashlib.sha256((directory / "original").read_bytes()).hexdigest(),
                        bookmarks=bookmarks, transcript=transcript, evidence=evidence + transcript, report=report)
