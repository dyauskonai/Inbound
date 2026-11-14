import asyncio
import base64
import binascii
import hashlib
import hmac
import io
import json
import logging
import os
import sqlite3
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ValidationError

from .auth import AccessControl, TunnelGuard
from . import media
from .models import AudioPart, CaptureInput, FinishInput, NoteInput, PhotoLink, SessionInput, VideoState, VitalInput
from .processing import Processor
from .store import Store


ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
MAX_UPLOAD = 512 * 1024 * 1024
MAX_PHOTO = 20 * 1024 * 1024
log = logging.getLogger("uvicorn.error")


def fetch_photo(url: str) -> bytes:
    """Read a photo link the phone could not download itself."""
    try:
        if url.startswith("data:"):
            header, _, payload = url.partition(",")
            return base64.b64decode(payload) if header.endswith(";base64") else urllib.parse.unquote_to_bytes(payload)
        if not url.startswith("https://"):
            raise ValueError("unsupported link")
        with urllib.request.urlopen(url, timeout=15) as response:
            data = response.read(MAX_PHOTO + 1)
    except (OSError, ValueError, binascii.Error) as error:
        raise HTTPException(502, "The Mac could not download the photo.") from error
    if len(data) > MAX_PHOTO:
        raise HTTPException(413, "Photos must be under 20 MB")
    return data


def normalize_photo(data: bytes) -> bytes:
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((2048, 2048))
        output = io.BytesIO()
        image.save(output, "JPEG", quality=88)
    return output.getvalue()


def live_progress(session: dict) -> str:
    seconds = int(sum(part["bytes"] / (part["rate"] * 2) for part in session.get("audio_parts", {}).values()))
    photos = len(session.get("photos", []))
    return (f"Receiving from the glasses · {seconds // 60}:{seconds % 60:02d} audio · "
            f"{photos} photo{'' if photos == 1 else 's'} · {len(session.get('notes', []))} transcript lines")


def create_app(data_dir: Path | None = None, live_port: int | None = None, video_wait: float = 120):
    store = Store(data_dir or Path(os.getenv("INBOUND_DATA_DIR", ROOT / "runtime")))
    processor = Processor(store)
    upload_locks = {}
    demo_lock = asyncio.Lock()
    if live_port:
        from .live import LiveRecorder
        live = LiveRecorder(store, live_port, upload_locks)
    else:
        live = None

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        yield
        if live and live.active:
            await live.stop(live.active.session_id, grace=0)
        processor.pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Inbound", lifespan=lifespan)
    app.add_middleware(AccessControl, device_token=os.getenv("INBOUND_DEVICE_TOKEN") or None,
                       dashboard_password=os.getenv("INBOUND_DASHBOARD_PASSWORD") or None)
    public_url = os.getenv("INBOUND_PUBLIC_URL") or None

    def upload_token_ok(session_id: str, token: str) -> bool:
        try:
            expected = store.get(session_id).get("upload_token_hash")
        except KeyError:
            return False
        return bool(expected and token) and hmac.compare_digest(expected, hashlib.sha256(token.encode()).hexdigest())

    if public_url:
        # scripts/dev.py --tunnel: the glasses upload video over the internet; nothing else is exposed.
        app.add_middleware(TunnelGuard, verify=upload_token_ok)
    app.state.store = store
    app.state.processor = processor

    def get_session(session_id):
        try:
            return store.get(session_id)
        except KeyError:
            raise HTTPException(404, "Session not found")

    @app.get("/api/health")
    def health():
        try:
            from .voice import MODEL_DIR
            voice_ready = (MODEL_DIR / "am/final.mdl").exists()
        except ImportError:
            # The cloud server has no Mac recorder, so it may run without Vosk.
            voice_ready = False
        return {"ok": True, "ai_configured": bool(os.getenv("OPENAI_API_KEY")),
                "live_capture": live is not None,
                "local_voice_ready": voice_ready,
                "video_upload_url": public_url,
                "transcribe_model": os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-transcribe"),
                "report_model": os.getenv("OPENAI_REPORT_MODEL", "gpt-4.1")}

    @app.websocket("/voice")
    async def voice_socket(socket: WebSocket):
        from .voice import accept, recognizer
        # Camera/mic streams are accepted only from this dashboard origin.
        origin = socket.headers.get("origin")
        if origin and origin.split("://", 1)[-1] != socket.headers.get("host"):
            await socket.close(code=1008)
            return
        await socket.accept()
        try:
            decoder = await asyncio.to_thread(recognizer)
            await socket.send_json({"ready": True})
            while True:
                chunk = await socket.receive_bytes()
                if len(chunk) > 64000 or len(chunk) % 2:
                    await socket.close(code=1009)
                    break
                result = await asyncio.to_thread(accept, decoder, chunk)
                if result:
                    await socket.send_json(result)
        except WebSocketDisconnect:
            pass
        except ValueError as error:
            await socket.send_json({"error": str(error)})
            await socket.close()

    @app.get("/api/sessions")
    def sessions():
        return [{key: item[key] for key in ("id", "title", "source", "created_at", "status", "duration", "progress")}
                for item in store.list() if not item.get("hidden")]

    @app.post("/api/sessions", status_code=201)
    def create_session(body: SessionInput, response: Response):
        try:
            session = store.create(body.title, body.source, body.id)
        except sqlite3.IntegrityError:
            # The phone retries a create it could not confirm. Answer with the session it already made.
            session = get_session(body.id)
            if session["source"] != body.source:
                raise HTTPException(409, "This session ID belongs to another recording.")
            response.status_code = 200
            return session
        if body.source == "glasses" and body.auto_report:
            session = store.update(session["id"], auto_report=True)
        if body.upload_token:
            session = store.update(session["id"], upload_token_hash=hashlib.sha256(body.upload_token.encode()).hexdigest())
        if body.check:
            session = store.update(session["id"], hidden=True)
        log.info("Inbound capture created session=%s source=%s", session["id"], body.source)
        return {**session, "live_capture": live is not None} if body.source == "glasses" else session

    @app.get("/api/sessions/{session_id}")
    def session(session_id: str):
        return get_session(session_id)

    @app.post("/api/sessions/{session_id}/live/start")
    async def live_start(session_id: str):
        get_session(session_id)
        if not live:
            raise HTTPException(503, "Run the Inbound Mac server with --lan to receive glasses video.")
        return await live.open(session_id)

    @app.post("/api/sessions/{session_id}/live/stop")
    async def live_stop(session_id: str):
        get_session(session_id)
        if not live:
            raise HTTPException(503, "The Mac live video receiver is disabled.")
        return await live.stop(session_id)

    @app.put("/api/sessions/{session_id}/capture")
    def capture(session_id: str, body: CaptureInput):
        bookmarks = [item.model_dump() for item in body.bookmarks]
        if len({item["id"] for item in bookmarks}) != len(bookmarks):
            raise HTTPException(422, "Snap IDs must be unique")
        with processor.lock:
            session = get_session(session_id)
            if session_id in processor.active:
                if bookmarks == session["bookmarks"] and body.started_at == session.get("started_at"):
                    return session
                raise HTTPException(409, "Wait for processing to finish before editing snaps")
            changes = {"bookmarks": bookmarks, "started_at": body.started_at}
            if bookmarks != session["bookmarks"] and session["report"]:
                changes.update(report=None, status="uploaded", progress="Snaps changed. Generate the report again.")
            saved = store.update(session_id, **changes)
            log.info("Inbound capture marks saved session=%s count=%d", session_id, len(bookmarks))
            return saved

    def phone_session(session_id: str) -> dict:
        session = get_session(session_id)
        if session["source"] != "glasses" or session["has_video"]:
            raise HTTPException(409, "This session does not accept uploads from the glasses MiniApp.")
        return session

    def record_upload(session: dict, **changes) -> dict:
        if session["status"] in {"created", "recording"}:
            changes["status"] = "recording"
            changes["progress"] = live_progress({**session, **changes})
        return store.update(session["id"], **changes)

    @app.post("/api/sessions/{session_id}/audio")
    async def audio(session_id: str, part: AudioPart):
        if part.format and not part.format.lower().startswith("pcm"):
            raise HTTPException(415, "Inbound needs PCM audio from the phone.")
        try:
            data = b"".join(base64.b64decode(chunk, validate=True) for chunk in part.chunks)
        except (binascii.Error, ValueError):
            raise HTTPException(422, "Audio chunks must be base64 encoded")
        if len(data) > 16 * 1024 * 1024:
            raise HTTPException(413, "Send audio in smaller parts")
        async with upload_locks.setdefault(session_id, asyncio.Lock()):
            session = phone_session(session_id)
            parts = session.get("audio_parts", {})
            if str(part.seq) not in parts:
                # 16-bit samples: drop a stray trailing byte rather than shift every later sample.
                data = data[:len(data) - len(data) % 2]
                (store.media_dir(session_id) / f"audio-{part.seq:06d}.pcm").write_bytes(data)
                parts[str(part.seq)] = {"at": part.at, "rate": part.sample_rate, "bytes": len(data)}
                record_upload(session, audio_parts=parts)
        return {"ok": True}

    @app.post("/api/sessions/{session_id}/photos")
    async def photo(session_id: str, request: Request, seq: int = Query(ge=1, le=40), seconds: float = Query(ge=0, le=7200)):
        phone_session(session_id)
        if int(request.headers.get("content-length") or 0) > MAX_PHOTO:
            raise HTTPException(413, "Photos must be under 20 MB")
        body = await request.body()
        if request.headers.get("content-type", "").startswith("application/json"):
            try:
                link = PhotoLink.model_validate_json(body)
            except ValidationError:
                raise HTTPException(422, "Send the photo or a photo link")
            body = await asyncio.to_thread(fetch_photo, link.url)
        try:
            jpeg = await asyncio.to_thread(normalize_photo, body)
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            raise HTTPException(422, "The upload is not a readable image")
        async with upload_locks.setdefault(session_id, asyncio.Lock()):
            session = phone_session(session_id)
            photos = session.get("photos", [])
            if all(item["seq"] != seq for item in photos):
                name = f"photo-{seq}.jpg"
                (store.media_dir(session_id) / name).write_bytes(jpeg)
                photos = sorted([*photos, {"id": f"snap_photo-{seq}", "seq": seq, "seconds": seconds, "file": name}], key=lambda item: item["seq"])
                record_upload(session, photos=photos)
                log.info("Inbound photo saved session=%s seq=%d bytes=%d", session_id, seq, len(jpeg))
        return {"ok": True}

    @app.post("/api/sessions/{session_id}/notes")
    async def note(session_id: str, body: NoteInput):
        async with upload_locks.setdefault(session_id, asyncio.Lock()):
            session = phone_session(session_id)
            notes = session.get("notes", [])
            if len(notes) >= 5000:
                raise HTTPException(413, "This capture already has 5000 transcript lines")
            if all(item["seq"] != body.seq for item in notes):
                record_upload(session, notes=sorted([*notes, body.model_dump()], key=lambda item: item["seq"]))
        return {"ok": True}

    def attach_frames(session_id: str) -> int:
        """Fill snaps the camera refused while recording with stills from the glasses video."""
        session = store.get(session_id)
        video = session.get("video") or {}
        taken = {photo["seq"] for photo in session.get("photos", [])}
        frames = [frame for frame in session.get("video_frames", []) if frame["seq"] not in taken]
        if video.get("state") != "ready" or not frames:
            return 0
        directory = store.media_dir(session_id)
        added = []
        for frame in frames:
            name = f"photo-{frame['seq']}.jpg"
            try:
                media.extract_frame(directory / video["file"], frame["seconds"] - (video.get("offset") or 0),
                                    video["duration"], directory / name)
            except ValueError:
                log.warning("Inbound could not extract snap %d from the video session=%s", frame["seq"], session_id)
                continue
            added.append({"id": f"snap_photo-{frame['seq']}", "seq": frame["seq"], "seconds": frame["seconds"],
                          "file": name, "from_video": True})
        store.update(session_id, photos=sorted([*session.get("photos", []), *added], key=lambda item: item["seq"]))
        return len(added)

    def waiting_frames(session: dict) -> int:
        taken = {photo["seq"] for photo in session.get("photos", [])}
        return sum(frame["seq"] not in taken for frame in session.get("video_frames", []))

    @app.post("/api/sessions/{session_id}/vitals")
    async def vital(session_id: str, body: VitalInput):
        async with upload_locks.setdefault(session_id, asyncio.Lock()):
            session = phone_session(session_id)
            vitals = session.get("vitals", [])
            if all(item["seq"] != body.seq for item in vitals):
                record_upload(session, vitals=sorted([*vitals, body.model_dump()], key=lambda item: item["seq"]))
        return {"ok": True}

    @app.post("/api/sessions/{session_id}/finish")
    async def finish(session_id: str, body: FinishInput):
        async with upload_locks.setdefault(session_id, asyncio.Lock()):
            session = phone_session(session_id)
            if session.get("capture_finished"):
                return session
            frames = [frame.model_dump() for frame in body.video_frames]
            video_coming = (session.get("video") or {}).get("state") in {"recording", "uploading"}
            received = bool(session.get("audio_parts") or session.get("photos") or session.get("notes") or (frames and video_coming))
            session = store.update(
                session_id, capture_finished=True, capture_seconds=body.seconds, video_frames=frames,
                expected_audio_parts=body.audio_parts, expected_photos=body.photos,
                status="uploaded" if received else "failed",
                progress="Ready to generate report" if received else "Needs attention",
                error=None if received else "No audio, transcript, or photos reached the Mac for this capture.",
            )
            # The video can arrive before Stop's finish request.
            await asyncio.to_thread(attach_frames, session_id)
            pending = waiting_frames(store.get(session_id)) if received and video_coming else 0
            if pending:
                # Snaps the camera refused while recording come from the video, so the report waits for it.
                session = store.update(session_id, status="waiting_video",
                                       progress=f"Waiting for the glasses to upload the video for {pending} photo{'s' if pending > 1 else ''}")

                def give_up():
                    if store.get(session_id)["status"] == "waiting_video":
                        log.warning("Inbound video did not arrive; writing the report without it session=%s", session_id)
                        processor.submit(session_id)
                asyncio.get_running_loop().call_later(video_wait, give_up)
            log.info("Inbound capture finished session=%s audio_parts=%d photos=%d notes=%d video_frames=%d", session_id,
                     len(session.get("audio_parts", {})), len(session.get("photos", [])), len(session.get("notes", [])), len(frames))
        if received and session.get("auto_report") and not pending:
            processor.submit(session_id)
        return store.get(session_id)

    @app.post("/api/sessions/{session_id}/video-state")
    async def video_state(session_id: str, body: VideoState):
        async with upload_locks.setdefault(session_id, asyncio.Lock()):
            session = phone_session(session_id)
            video = session.get("video") or {}
            if video.get("state") != "ready":
                offset = {"offset": body.offset} if body.offset is not None else {}
                session = store.update(session_id, video={**video, "state": body.state, **offset, "detail": body.detail})
        if body.state == "failed" and session["status"] == "waiting_video":
            processor.submit(session_id)
        return {"ok": True}

    async def receive_video(session_id: str, video: UploadFile):
        session = get_session(session_id)
        log.info("Inbound upload received session=%s source=%s", session_id, session["source"])
        lock = upload_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            if live and live.active and live.active.session_id == session_id:
                await video.close()
                raise HTTPException(409, "Wait for the Mac to finish the live recording before attaching a clip.")
            directory = store.media_dir(session_id)
            temporary = directory / f"upload-{uuid4().hex}.part"
            digest = hashlib.sha256()
            size = 0
            try:
                with temporary.open("wb") as output:
                    while chunk := await video.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_UPLOAD:
                            raise HTTPException(413, "Video exceeds the 512 MB local upload limit")
                        digest.update(chunk)
                        output.write(chunk)
                if not size:
                    raise HTTPException(422, "The uploaded file is empty")
                session = get_session(session_id)
                checksum = digest.hexdigest()
                if session.get("video_hash"):
                    if session["video_hash"] != checksum:
                        raise HTTPException(409, "This session already has a different recording. Create a new session.")
                    return {"success": True, "requestId": session_id, "statusUrl": f"/api/sessions/{session_id}"}
                try:
                    info = await asyncio.to_thread(media.inspect, temporary)
                except ValueError as error:
                    raise HTTPException(422, str(error))
                if session["source"] == "glasses":
                    # The glasses' own video sits beside the phone's audio and photos. The report
                    # doesn't depend on it, except for snaps the camera refused while recording.
                    try:
                        await asyncio.to_thread(media.web_video, temporary, directory / "video.mp4")
                    except ValueError as error:
                        raise HTTPException(422, str(error))
                    details = {**(session.get("video") or {}), "state": "ready", "file": "video.mp4",
                               "duration": info["duration"], "has_audio": info["has_audio"], "bytes": size, "detail": None}
                    store.update(session_id, video=details, video_hash=checksum)
                    log.info("Inbound glasses video saved session=%s bytes=%d duration=%.2f", session_id, size, info["duration"])
                    added = await asyncio.to_thread(attach_frames, session_id)
                    status = store.get(session_id)["status"]
                    # A video attached later from the Mentra gallery brings stills the report lacks.
                    if added and status in {"complete", "awaiting_key", "failed", "interrupted"}:
                        store.update(session_id, status="uploaded", progress="Video attached. Writing the report again with its stills.")
                        status = "uploaded"
                    if status in {"waiting_video", "uploaded"}:
                        processor.submit(session_id)
                    return {"success": True, "requestId": session_id, "statusUrl": f"/api/sessions/{session_id}"}
                temporary.replace(directory / "original")
                store.update(session_id, has_video=True, video_hash=checksum, status="uploaded", progress="Ready to generate report")
                log.info("Inbound upload saved session=%s bytes=%d audio=%s duration=%.2f", session_id, size, info["has_audio"], info["duration"])
                if session.get("auto_report"):
                    processor.submit(session_id)
                return {"success": True, "requestId": session_id, "statusUrl": f"/api/sessions/{session_id}"}
            except HTTPException as error:
                log.warning("Inbound upload rejected session=%s status=%d reason=%s", session_id, error.status_code, error.detail)
                raise
            finally:
                temporary.unlink(missing_ok=True)
                await video.close()

    @app.post("/upload")
    async def mentra_upload(video: UploadFile = File(), requestId: str = Form()):
        return await receive_video(requestId, video)

    @app.post("/api/sessions/{session_id}/video")
    async def upload(session_id: str, video: UploadFile = File()):
        return await receive_video(session_id, video)

    @app.post("/api/sessions/{session_id}/process", status_code=202)
    def process(session_id: str):
        session = get_session(session_id)
        if not (session["has_video"] or session.get("audio_parts") or session.get("photos") or session.get("notes")):
            raise HTTPException(409, "Upload the recording first")
        if session["source"] == "sample":
            return session
        if session["status"] == "complete":
            return session
        processor.submit(session_id)
        return store.get(session_id)

    @app.get("/api/sessions/{session_id}/report.json")
    def export_report(session_id: str):
        session = get_session(session_id)
        if not session["report"]:
            raise HTTPException(409, "The report is still being prepared")
        return {"session": session, "format_version": 1}

    @app.get("/media/{session_id}/{filename}")
    def media_file(session_id: str, filename: str):
        session = get_session(session_id)
        allowed = {"recording.mp4", "recording.wav", "video.mp4", *(item["file"] for item in session.get("photos", []))}
        for item in session["evidence"]:
            allowed.update(item[key] for key in ("file", "clip") if key in item)
        if filename not in allowed:
            raise HTTPException(404, "Media not found")
        path = store.media_dir(session_id) / filename
        if not path.is_file():
            raise HTTPException(404, "Media is still processing")
        return FileResponse(path)

    @app.post("/api/sample")
    async def sample():
        from .sample import create_sample
        async with demo_lock:
            for entry in store.list():
                if entry["source"] == "sample" and entry["status"] == "complete":
                    return entry
            return await asyncio.to_thread(create_sample, store)

    @app.get("/events")
    async def events(request: Request):
        async def stream():
            previous = ""
            while not await request.is_disconnected():
                items = store.list()
                revision = json.dumps([(item["id"], item["updated_at"]) for item in items])
                if revision != previous:
                    yield "event: update\ndata: " + revision + "\n\n"
                    previous = revision
                else:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(2)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=ROOT / "dashboard"), name="static")

    @app.get("/")
    def index():
        return FileResponse(ROOT / "dashboard/index.html")

    return app


app = create_app(live_port=int(os.environ["INBOUND_RTMP_PORT"]) if os.getenv("INBOUND_RTMP_PORT") else None)
