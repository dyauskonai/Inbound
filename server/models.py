from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Bookmark(BaseModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    seconds: float = Field(ge=0, le=7200, allow_inf_nan=False)
    label: str = Field(default="Snap", max_length=160)


class SessionInput(BaseModel):
    title: str = Field(default="New recording", min_length=1, max_length=120)
    source: Literal["glasses", "upload", "mac"] = "upload"
    auto_report: bool = False


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


class GeneratedReport(Report):
    snap_captions: list[SnapCaption]


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
        expected = {item["id"] for item in evidence if item.get("clip")}
        received = [item.evidence_id for item in report.snap_captions]
        if set(received) != expected or len(received) != len(expected) or any(not item.caption.strip() for item in report.snap_captions):
            raise ValueError("The report did not describe every saved snap. Retry generation.")
    for entry in result["timeline"]:
        entry["seconds"] = min(sources[key]["start"] for key in entry["evidence_ids"])
    result["timeline"].sort(key=lambda entry: entry["seconds"])
    return result
