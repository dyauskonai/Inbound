import math
import re
import shutil
import subprocess
import wave
from pathlib import Path

import imageio_ffmpeg


FFMPEG = shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()


def ffmpeg(*args: str, timeout: int = 300):
    result = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-y", *map(str, args)],
        capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode:
        raise ValueError("Media processing failed. Check that the uploaded file is a playable video.")
    return result


def inspect(path: Path) -> dict:
    result = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=30)
    match = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", result.stderr)
    if "Video:" not in result.stderr:
        raise ValueError("Upload a video with a video track.")
    if match:
        duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
    else:
        # Browser MediaRecorder WebM files commonly omit container duration.
        decoded = ffmpeg("-i", path, "-map", "0:v:0", "-progress", "pipe:1", "-f", "null", "-", timeout=300)
        times = re.findall(r"out_time_us=(\d+)", decoded.stdout)
        if not times:
            raise ValueError("Could not read the recording duration.")
        duration = int(times[-1]) / 1_000_000
    if not 0 < duration <= 7200:
        raise ValueError("Recordings must be between 0 and 120 minutes.")
    return {"duration": duration, "has_audio": "Audio:" in result.stderr}


def prepare(directory: Path, bookmarks: list[dict], *, glasses=False) -> tuple[dict, list[dict]]:
    source = directory / "original"
    info = inspect(source)
    duration = info["duration"]
    # The phone clock starts when the glasses acknowledge recording. The video
    # duration comes from a separate clock and can differ at the end of a clip.
    tolerance = 2 if glasses else 0.5
    if any(item["seconds"] > duration + tolerance for item in bookmarks):
        raise ValueError("A snap falls outside the recording. Correct its timestamp before retrying.")
    ffmpeg("-i", source, "-map", "0:v:0", "-map", "0:a?", "-vf", "scale=1280:-2:force_original_aspect_ratio=decrease",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-movflags", "+faststart", directory / "recording.mp4")
    # Bounded sampling, plus every explicit snap. The report states this coverage.
    interval = max(8, duration / 24)
    samples = [{"id": f"frame_{i}", "seconds": t, "label": "Sampled frame"}
               for i, t in enumerate([round(n * interval, 3) for n in range(math.ceil(duration / interval))])]
    selected = [{**item, "id": "snap_" + item["id"]} for item in bookmarks]
    samples = [item for item in samples if all(abs(item["seconds"] - snap["seconds"]) > 1 for snap in selected)]
    evidence = []
    for item in selected + samples:
        name = item["id"]
        seconds = extract_frame(directory / "recording.mp4", min(item["seconds"], duration), duration, directory / f"{name}.jpg", item["label"])
        entry = {"id": name, "kind": "image", "start": seconds, "end": seconds,
                 "label": item["label"], "file": f"{name}.jpg"}
        if name.startswith("snap_"):
            start = max(0, seconds - 3)
            end = min(duration, seconds + 5)
            ffmpeg("-ss", start, "-i", directory / "recording.mp4", "-t", end - start,
                   "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-movflags", "+faststart", directory / f"{name}.mp4")
            entry.update(clip=f"{name}.mp4", clip_start=start, clip_end=end)
        evidence.append(entry)
    return info, sorted(evidence, key=lambda item: item["start"])


def extract_frame(video: Path, seconds: float, duration: float, still: Path, label: str = "the photo") -> float:
    """Save the frame nearest `seconds` as a JPEG and return the time actually used."""
    seconds = min(max(0, seconds), max(0, duration - 0.1))
    still.unlink(missing_ok=True)
    ffmpeg("-ss", seconds, "-i", video, "-frames:v", "1", "-q:v", "3", still)
    if not still.is_file():
        # FFmpeg can return success with no image when a seek lands after
        # the last decodable frame, particularly with low frame rates.
        seconds = min(seconds, max(0, duration - 0.5))
        ffmpeg("-ss", seconds, "-i", video, "-frames:v", "1", "-q:v", "3", still)
        if not still.is_file():
            raise ValueError(f"Could not extract the still for {label}.")
    return seconds


def web_video(source: Path, target: Path):
    """Make an uploaded clip seekable in browsers, re-encoding only when a copy won't do."""
    try:
        ffmpeg("-i", source, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", target)
    except ValueError:
        ffmpeg("-i", source, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
               "-c:a", "aac", "-movflags", "+faststart", target)


def prepare_phone(directory: Path, session: dict) -> tuple[dict, list[dict]]:
    """Join the phone's audio parts into one WAV and index its photos as evidence."""
    parts = sorted(session.get("audio_parts", {}).items(), key=lambda item: int(item[0]))
    rate = parts[0][1]["rate"] if parts else 16000
    written = 0
    if parts:
        with wave.open(str(directory / "recording.wav"), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            for seq, part in parts:
                if part["rate"] != rate:
                    continue
                # Keep audio aligned with photo times when the mic stream paused.
                offset = int(part["at"] * rate) * 2
                if offset - written > rate * 2:
                    output.writeframes(bytes(offset - written))
                    written = offset
                data = (directory / f"audio-{int(seq):06d}.pcm").read_bytes()
                output.writeframes(data)
                written += len(data)
    duration = written / (rate * 2)
    photos = session.get("photos", [])
    if not duration:
        duration = max([session.get("capture_seconds") or 0, *(photo["seconds"] for photo in photos)])
    evidence = [{"id": photo["id"], "kind": "image", "start": photo["seconds"], "end": photo["seconds"],
                 "label": f"Photo {photo['seq']}", "file": photo["file"],
                 # For the report model: these timings tie a misheard command back to "snap".
                 "note": "Taken the moment the phone heard the medic say snap"
                         + (", as a still from the glasses video because the camera was recording." if photo.get("from_video") else ".")}
                for photo in photos]
    info = {"duration": round(duration, 2) or None, "has_audio": written > 0, "media": "audio" if written else None}
    return info, sorted(evidence, key=lambda item: item["start"])


def audio_chunks(directory: Path, duration: float, source: str = "original"):
    # Accurate chunk boundaries are retained even when the STT provider returns text only.
    for index, start in enumerate(range(0, math.ceil(duration), 30)):
        path = directory / f"audio_{index}.wav"
        end = min(duration, start + 30)
        ffmpeg("-ss", start, "-i", directory / source, "-t", end - start,
               "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path)
        yield path, start, end
