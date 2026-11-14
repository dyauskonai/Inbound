import hashlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .media import ffmpeg, prepare
from .processing import vital_evidence

# Bump when the scenario changes, so "Open a sample patient" stops reusing the old one.
SAMPLE_VERSION = 2

# Fictional: a scripted training handover, so every part of the ER dashboard has something to show.
VITALS = [
    {"seq": 1, "kind": "bp", "value": "90/60", "status": "conflict", "seconds": 6.2, "candidates": ["190/90", "90/60"]},
    {"seq": 2, "kind": "bp", "value": "90/60", "status": "confirmed", "seconds": 7.6, "candidates": ["190/90", "90/60"]},
    {"seq": 3, "kind": "hr", "value": "110", "status": "heard", "seconds": 8.4, "candidates": []},
    {"seq": 4, "kind": "spo2", "value": "96", "status": "heard", "seconds": 8.9, "candidates": []},
    {"seq": 5, "kind": "rr", "value": "22", "status": "heard", "seconds": 9.5, "candidates": []},
    {"seq": 6, "kind": "hr", "value": "118", "status": "updated", "seconds": 13.4, "candidates": ["110"]},
]


def create_sample(store):
    session = store.create("Training handover · fall from a ladder", "sample")
    directory = store.media_dir(session["id"])
    font_path = Path("/System/Library/Fonts/Helvetica.ttc")
    def font(size):
        return ImageFont.truetype(str(font_path), size) if font_path.exists() else ImageFont.load_default(size=size)
    scenes = [
        ("Arrival and assessment", "54-year-old man fell about three metres from a ladder.", "Alert, GCS 15. Deformed left forearm, scalp laceration."),
        ("Vitals, read back by the glasses", "BP 190 over 90, correction 90 over 60. Glasses: repeat the BP?", "Medic: 90 over 60. Heart rate 110, SpO2 96%, resp rate 22."),
        ("Treatment and handover", "Forearm splinted, oxygen 2 L/min. Takes warfarin for AF.", "Heart rate now 118. ETA twelve minutes."),
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
    ffmpeg("-framerate", "1/5", "-i", directory / "scene%d.png", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
           "-t", "15", "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", directory / "sample.mp4")
    (directory / "sample.mp4").replace(directory / "original")
    bookmarks = [{"id": "forearm", "seconds": 2.5, "label": "Left forearm"},
                 {"id": "vitals", "seconds": 7.5, "label": "Vitals read-back"},
                 {"id": "handoff", "seconds": 12.5, "label": "Handover details"}]
    info, evidence = prepare(directory, bookmarks)
    transcript = [
        {"id": "audio_0", "kind": "transcript", "start": 0, "end": 5, "text": "Scripted example: Fifty-four-year-old man, fell about three metres from a ladder. Alert and talking, GCS fifteen. Obvious deformity of the left forearm and a scalp laceration."},
        {"id": "audio_1", "kind": "transcript", "start": 5, "end": 10, "text": "Scripted example: BP one ninety over ninety. Correction, ninety over sixty. (Glasses: Can you repeat the blood pressure?) Ninety over sixty. Heart rate one ten, sats ninety-six percent, resp rate twenty-two."},
        {"id": "audio_2", "kind": "transcript", "start": 10, "end": 15, "text": "Scripted example: Forearm splinted, oxygen two litres by nasal cannula. He takes warfarin for atrial fibrillation. Heart rate now one eighteen. ETA twelve minutes."},
    ]
    vitals = [vital_evidence(vital) for vital in VITALS]
    report = {
        "title": "Fall from ladder, deformed left forearm, on warfarin",
        "summary": [
            {"text": "In this fictional training handover, a 54-year-old man fell about three metres from a ladder. He is alert with a GCS of 15, with a deformed left forearm and a scalp laceration.", "evidence_ids": ["audio_0", "snap_forearm"]},
            {"text": "Blood pressure was given as 190/90 and corrected to 90/60; the glasses asked for it again and the medic repeated 90/60. Heart rate 110, later updated to 118. SpO2 96%, respiratory rate 22.", "evidence_ids": ["audio_1", "vital_2", "vital_6"]},
            {"text": "He takes warfarin for atrial fibrillation. The forearm was splinted and oxygen started at 2 L/min. ETA 12 minutes.", "evidence_ids": ["audio_2"]},
        ],
        "sections": [
            {"heading": "Presentation", "statements": [{"text": "The reported mechanism is a fall of about three metres from a ladder. The medic reports a deformed left forearm and a scalp laceration, and a GCS of 15.", "evidence_ids": ["audio_0", "snap_forearm"]}]},
            {"heading": "Vital signs", "statements": [
                {"text": "Blood pressure 90/60 was confirmed by read-back after the medic corrected 190/90.", "evidence_ids": ["audio_1", "vital_1", "vital_2"]},
                {"text": "Heart rate was reported as 110 and later updated to 118. SpO2 96%. Respiratory rate 22.", "evidence_ids": ["vital_3", "vital_4", "vital_5", "vital_6"]},
            ]},
            {"heading": "Treatment given", "statements": [{"text": "The left forearm was splinted. Oxygen 2 L/min by nasal cannula.", "evidence_ids": ["audio_2"]}]},
            {"heading": "Medications and history", "statements": [{"text": "The medic reports that the patient takes warfarin for atrial fibrillation.", "evidence_ids": ["audio_2"]}]},
            {"heading": "Visual record", "statements": [{"text": "The marked photos show generated training title cards, not a patient.", "evidence_ids": ["snap_forearm", "snap_vitals", "snap_handoff"]}]},
        ],
        "timeline": [
            {"seconds": 0, "title": "Arrival and assessment", "detail": "Mechanism, consciousness, and injuries reported.", "evidence_ids": ["audio_0", "snap_forearm"]},
            {"seconds": 6.2, "title": "Blood pressure read back", "detail": "190/90 corrected to 90/60. The glasses asked to repeat it and the medic confirmed 90/60.", "evidence_ids": ["vital_1", "vital_2", "snap_vitals"]},
            {"seconds": 10, "title": "Treatment and medications", "detail": "Forearm splinted, oxygen started. Warfarin for atrial fibrillation.", "evidence_ids": ["audio_2"]},
            {"seconds": 13.4, "title": "Heart rate updated", "detail": "Heart rate changed from 110 to 118 and read back. ETA 12 minutes.", "evidence_ids": ["vital_6", "snap_handoff"]},
        ],
        "snap_captions": [
            {"evidence_id": "snap_forearm", "caption": "Training title card with the arrival notes: a fall from a ladder, a deformed left forearm, and a scalp laceration."},
            {"evidence_id": "snap_vitals", "caption": "Training title card showing the blood pressure correction and the glasses' read-back."},
            {"evidence_id": "snap_handoff", "caption": "Training title card listing the treatment, warfarin, and the ETA."},
        ],
        "handoff": {"patient_age": "54", "patient_sex": "Male", "mechanism": "Fall from a ladder, about 3 metres",
                    "injuries": ["Deformed left forearm", "Scalp laceration"],
                    "blood_pressure": "90/60", "heart_rate": "118", "spo2": "96%", "respiratory_rate": "22",
                    "consciousness": "Alert, GCS 15", "treatment": ["Left forearm splinted", "Oxygen 2 L/min by nasal cannula"],
                    "allergies": None, "medications": "Warfarin", "history": "Atrial fibrillation", "eta_minutes": 12,
                    "missing_fields": ["allergies"], "evidence_ids": ["audio_0", "audio_1", "audio_2"],
                    "confirmed_fields": ["blood_pressure"], "updated_fields": ["heart_rate"]},
        "uncertainties": ["This is a fixed sample with a fictional patient. AI did not write it.",
                          "The photos and video are generated title cards, not images of a patient.",
                          "Allergies were not reported.",
                          "Real captures need an OpenAI API key for transcription and the report."],
    }
    return store.update(session["id"], **info, status="complete", progress="Sample report ready", has_video=True,
                        video_hash=hashlib.sha256((directory / "original").read_bytes()).hexdigest(), sample_version=SAMPLE_VERSION,
                        bookmarks=bookmarks, transcript=transcript, vitals=VITALS, evidence=sorted(evidence + transcript + vitals, key=lambda item: item["start"]),
                        report=report)
