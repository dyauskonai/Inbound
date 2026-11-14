import asyncio
import hashlib
import json
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .models import CaptureInput, SessionInput
from .processing import Processor
from .store import Store


ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
MAX_UPLOAD = 512 * 1024 * 1024
log = logging.getLogger("uvicorn.error")


def create_app(data_dir: Path | None = None, live_port: int | None = None):
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
    app.state.store = store
    app.state.processor = processor

    def get_session(session_id):
        try:
            return store.get(session_id)
        except KeyError:
            raise HTTPException(404, "Session not found")

    @app.get("/api/health")
    def health():
        from .voice import MODEL_DIR
        return {"ok": True, "ai_configured": bool(os.getenv("OPENAI_API_KEY")),
                "live_capture": live is not None,
                "local_voice_ready": (MODEL_DIR / "am/final.mdl").exists(),
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
                for item in store.list()]

    @app.post("/api/sessions", status_code=201)
    def create_session(body: SessionInput):
        session = store.create(body.title, body.source)
        if body.source == "glasses" and body.auto_report:
            session = store.update(session["id"], auto_report=True)
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
                from .media import inspect
                try:
                    info = await asyncio.to_thread(inspect, temporary)
                except ValueError as error:
                    raise HTTPException(422, str(error))
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
        if not session["has_video"]:
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
        allowed = {"recording.mp4"}
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
