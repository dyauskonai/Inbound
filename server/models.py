from typing import Literal

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
    """Reject invented source links and derive timeline times from real media."""
    sources = {item["id"]: item for item in evidence}
    entries = [*report.summary, *report.timeline]
    for section in report.sections:
        entries.extend(section.statements)
    for entry in entries:
        if not entry.evidence_ids or any(key not in sources for key in entry.evidence_ids):
            raise ValueError("The report contains a statement without valid source evidence. Retry generation.")
    result = report.model_dump()
    if isinstance(report, GeneratedReport):
        # An empty handoff card cites nothing; one with values must cite real evidence.
        if any(key not in sources for key in report.handoff.evidence_ids):
            raise ValueError("The handoff card cites unknown evidence. Retry generation.")
        expected = {item["id"] for item in evidence if item["kind"] == "image" and item["id"].startswith("snap_")}
        received = [item.evidence_id for item in report.snap_captions]
        if set(received) != expected or len(received) != len(expected) or any(not item.caption.strip() for item in report.snap_captions):
            raise ValueError("The report did not describe every saved snap. Retry generation.")
    for entry in result["timeline"]:
        entry["seconds"] = min(sources[key]["start"] for key in entry["evidence_ids"])
    result["timeline"].sort(key=lambda entry: entry["seconds"])
    return result
