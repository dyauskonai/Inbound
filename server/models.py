from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class Bookmark(BaseModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    seconds: float = Field(ge=0, le=7200, allow_inf_nan=False)
    label: str = Field(default="Snap", max_length=160)


class SessionInput(BaseModel):
    # The glasses MiniApp names its session so a retried create is harmless.
    id: str | None = Field(default=None, pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
    title: str = Field(default="New recording", min_length=1, max_length=120)
    source: Literal["glasses", "upload", "mac"] = "upload"
    # The phone's per-capture secret for the glasses' video upload through the tunnel. Only its hash is kept.
    upload_token: str | None = Field(default=None, min_length=32, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    auto_report: bool = False
    # A "Test video upload" from the MiniApp: kept off the dashboard's list.
    check: bool = False


class AudioPart(BaseModel):
    seq: int = Field(ge=1, le=100_000)
    # Seconds from Start to the first sample in this part; gaps are filled with silence.
    at: float = Field(ge=0, le=7200, allow_inf_nan=False)
    sample_rate: Literal[8000, 16000, 22050, 24000, 32000, 44100, 48000] = 16000
    format: str | None = Field(default=None, max_length=40)
    chunks: list[str] = Field(min_length=1, max_length=2000)


class NoteInput(BaseModel):
    seq: int = Field(ge=1, le=100_000)
    seconds: float = Field(ge=0, le=7200, allow_inf_nan=False)
    text: str = Field(min_length=1, max_length=2000)


class VideoFrame(BaseModel):
    """A snap the camera refused while recording video; its still comes from the video."""
    seq: int = Field(ge=1, le=40)
    seconds: float = Field(ge=0, le=7200, allow_inf_nan=False)


class VideoState(BaseModel):
    state: Literal["recording", "uploading", "failed"]
    # Seconds from Start until the glasses confirmed video recording.
    offset: float | None = Field(default=None, ge=0, le=7200, allow_inf_nan=False)
    detail: str | None = Field(default=None, max_length=300)


class VitalInput(BaseModel):
    """A critical vital the phone heard, and whether the medic confirmed it by repeating it."""
    seq: int = Field(ge=1, le=100_000)
    kind: Literal["bp", "hr", "spo2", "rr"]
    # Empty when every value the medic gave was unclear.
    value: str = Field(pattern=r"^(\d{1,3}(/\d{1,3})?)?$")
    status: Literal["heard", "conflict", "confirmed", "updated", "unconfirmed"]
    seconds: float = Field(ge=0, le=7200, allow_inf_nan=False)
    candidates: list[Annotated[str, Field(pattern=r"^(\d{1,3}(/\d{1,3})?|unclear)$")]] = Field(default_factory=list, max_length=6)


class PhotoLink(BaseModel):
    url: str = Field(min_length=8, max_length=8_000_000)


class FinishInput(BaseModel):
    audio_parts: int = Field(default=0, ge=0, le=100_000)
    notes: int = Field(default=0, ge=0, le=100_000)
    photos: int = Field(default=0, ge=0, le=40)
    seconds: float = Field(default=0, ge=0, le=7200, allow_inf_nan=False)
    video_frames: list[VideoFrame] = Field(default_factory=list, max_length=40)


class CaptureInput(BaseModel):
    bookmarks: list[Bookmark] = Field(default_factory=list, max_length=40)
    # Repeated metadata submissions are safe. Processing starts explicitly.
    started_at: str | None = None


class Statement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    evidence_ids: list[str]


class ReportSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    heading: str
    statements: list[Statement]


class TimelineEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    detail: str
    evidence_ids: list[str]


class Report(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    summary: list[Statement]
    sections: list[ReportSection]
    timeline: list[TimelineEntry]
    uncertainties: list[str]


class SnapCaption(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidence_id: str
    caption: str


class Handoff(BaseModel):
    """The ER handoff card. Every value is what the medic reported, or null."""
    model_config = ConfigDict(extra="forbid")
    patient_age: str | None
    patient_sex: str | None
    blood_pressure: str | None
    heart_rate: str | None
    spo2: str | None
    respiratory_rate: str | None
    injuries: list[str]
    mechanism: str | None
    allergies: str | None
    eta_minutes: int | None
    missing_fields: list[str]
    evidence_ids: list[str]


class GeneratedReport(Report):
    snap_captions: list[SnapCaption]
    handoff: Handoff


def validate_evidence(report: Report, evidence: list[dict]) -> dict:
    """Keep only statements backed by supplied evidence, and derive timeline times from real media.

    A citation the model invented is removed; a statement left with no real source is dropped
    rather than failing the whole report. A report with no supported summary is still an error.
    """
    sources = {item["id"]: item for item in evidence}
    result = report.model_dump()
    dropped = 0

    def supported(entries: list[dict]) -> list[dict]:
        nonlocal dropped
        kept = []
        for entry in entries:
            entry["evidence_ids"] = [key for key in dict.fromkeys(entry["evidence_ids"]) if key in sources]
            if entry["evidence_ids"]:
                kept.append(entry)
            else:
                dropped += 1
        return kept

    result["summary"] = supported(result["summary"])
    result["timeline"] = supported(result["timeline"])
    for section in result["sections"]:
        section["statements"] = supported(section["statements"])
    result["sections"] = [section for section in result["sections"] if section["statements"]]
    if not result["summary"]:
        raise ValueError("The report contains a statement without valid source evidence. Retry generation.")
    if dropped:
        result["uncertainties"].append(f"{dropped} statements were left out because they cited no supplied evidence."
                                       if dropped > 1 else "1 statement was left out because it cited no supplied evidence.")
    if isinstance(report, GeneratedReport):
        result["handoff"]["evidence_ids"] = [key for key in result["handoff"]["evidence_ids"] if key in sources]
        # Every saved snap gets exactly one caption, in evidence order.
        snaps = [item["id"] for item in evidence if item["kind"] == "image" and item["id"].startswith("snap_")]
        captions = {item["evidence_id"]: item["caption"].strip() for item in result["snap_captions"] if item["caption"].strip()}
        result["snap_captions"] = [{"evidence_id": key, "caption": captions.get(key, "The AI did not describe this photo.")} for key in snaps]
    for entry in result["timeline"]:
        entry["seconds"] = min(sources[key]["start"] for key in entry["evidence_ids"])
    result["timeline"].sort(key=lambda entry: entry["seconds"])
    return result
