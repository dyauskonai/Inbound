"""Receive one Mentra Live camera stream on the local network."""
import asyncio
import hashlib
import logging
import secrets
import signal
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

from .media import FFMPEG, inspect
from .store import Store

log = logging.getLogger("uvicorn.error")


@dataclass
class Recording:
    session_id: str
    process: asyncio.subprocess.Process
    path: Path
    key: str
    watcher: asyncio.Task | None = None


class LiveRecorder:
    def __init__(self, store: Store, port: int, upload_locks: dict):
        self.store = store
        self.port = port
        self.upload_locks = upload_locks
        self.active: Recording | None = None
        self.lock = asyncio.Lock()

    async def open(self, session_id: str) -> dict:
        async with self.lock, self.upload_locks.setdefault(session_id, asyncio.Lock()):
            session = self.store.get(session_id)
            if session["source"] != "glasses" or session["has_video"]:
                raise HTTPException(409, "Choose a new glasses session for live capture.")
            if self.active:
                if self.active.session_id == session_id:
                    return {"port": self.port, "key": self.active.key}
                raise HTTPException(409, "Another glasses recording is still receiving video on the Mac.")

            directory = self.store.media_dir(session_id)
            path = directory / "live-capture.part"
            key = secrets.token_urlsafe(18)
            self.store.update(session_id, live_state="waiting", live_started_at=None, progress="Waiting for glasses video", error=None)
            with (directory / "live-capture.log").open("wb") as errors:
                try:
                    process = await asyncio.create_subprocess_exec(
                        FFMPEG, "-hide_banner", "-nostdin", "-y", "-loglevel", "warning",
                        "-stats_period", "0.25", "-progress", "pipe:1", "-timeout", "25", "-tcp_nodelay", "1",
                        "-analyzeduration", "500000", "-probesize", "65536",
                        "-i", f"rtmp://0.0.0.0:{self.port}/live/{key}",
                        "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-t", "7195",
                        "-fs", str(512 * 1024 * 1024), "-f", "matroska", path,
                        stdout=asyncio.subprocess.PIPE, stderr=errors,
                    )
                except OSError as error:
                    self.store.update(session_id, live_state="failed", progress="Could not open the video receiver", error=str(error))
                    raise HTTPException(503, "The Mac could not start its video receiver.") from error
            recording = Recording(session_id, process, path, key)
            self.active = recording
            recording.watcher = asyncio.create_task(self.watch(recording))
            await asyncio.sleep(0.25)
            if process.returncode is not None:
                raise HTTPException(503, f"The Mac could not listen for glasses video on port {self.port}.")
            log.info("Inbound video receiver ready session=%s port=%d", session_id, self.port)
            return {"port": self.port, "key": key}

    async def watch(self, recording: Recording) -> None:
        session_id = recording.session_id
        try:
            assert recording.process.stdout is not None
            started = False
            async for line in recording.process.stdout:
                if not started and line.startswith(b"out_time_us="):
                    try:
                        elapsed = int(line.partition(b"=")[2]) / 1000
                    except ValueError:
                        continue
                    if elapsed > 0:
                        started = True
                        origin = round(time.time() * 1000 - elapsed)
                        self.store.update(session_id, live_state="recording", live_started_at=origin, progress="Recording from the glasses")
                        log.info("Inbound glasses video recording session=%s", session_id)
            await recording.process.wait()
            if not recording.path.is_file() or not recording.path.stat().st_size:
                raise ValueError("No video arrived from the glasses. Check their Wi-Fi and the Mac firewall.")
            info = await asyncio.to_thread(inspect, recording.path)
            with recording.path.open("rb") as video:
                digest = await asyncio.to_thread(hashlib.file_digest, video, "sha256")
            recording.path.replace(recording.path.parent / "original")
            self.store.update(
                session_id, live_state="saved", has_video=True, video_hash=digest.hexdigest(),
                status="uploaded", progress="Recording saved on the Mac",
            )
            log.info("Inbound live video saved session=%s audio=%s duration=%.2f", session_id, info["has_audio"], info["duration"])
        except (OSError, ValueError) as error:
            self.store.update(session_id, live_state="failed", progress="Glasses video receiver stopped", error=str(error))
            log.warning("Inbound live capture failed session=%s reason=%s", session_id, error)
        finally:
            if self.active is recording:
                self.active = None

    async def stop(self, session_id: str, grace: float = 2) -> dict:
        recording = self.active
        if recording and recording.session_id == session_id and recording.watcher:
            try:
                await asyncio.wait_for(asyncio.shield(recording.watcher), grace)
            except TimeoutError:
                if recording.process.returncode is None:
                    try:
                        recording.process.send_signal(signal.SIGINT)
                    except ProcessLookupError:
                        pass
                try:
                    await asyncio.wait_for(asyncio.shield(recording.watcher), 6)
                except TimeoutError:
                    if recording.process.returncode is None:
                        try:
                            recording.process.kill()
                        except ProcessLookupError:
                            pass
                    raise HTTPException(504, "The Mac is still closing the recording. Check again shortly.")
        return self.store.get(session_id)
