"""Temporary token-protected phone gateway. Bind to loopback behind HTTPS."""
import hmac
import json
import re
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "runtime" / "phone-connection.json"
config = json.loads(STATE.read_text())
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def authenticate(token):
    if not hmac.compare_digest(token, config["token"]):
        raise HTTPException(404)


@app.get("/connect/{token}/{filename:path}")
async def install(token: str, filename: str):
    authenticate(token)
    if filename == "__mentra_release/health":
        return {"ok": True}
    manifest_path = ROOT / "app/miniapp.json"
    manifest = json.loads(manifest_path.read_text())
    paths = {
        "miniapp.json": manifest_path,
        "icon.png": ROOT / "app/icon.png",
        "bundle.zip": ROOT / "app/build" / f"{manifest['packageName']}-{manifest['version']}.zip",
    }
    path = paths.get(filename)
    if path is None or not path.is_file():
        raise HTTPException(404)
    if filename == "bundle.zip":
        print(f"Inbound MiniApp {manifest['version']} bundle downloaded", flush=True)
    return FileResponse(path, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@app.api_route("/device/{token}/{path:path}", methods=["GET", "POST", "PUT"])
async def device(token: str, path: str, request: Request):
    authenticate(token)
    if not path:
        return HTMLResponse("<body style='font:18px system-ui;padding:30px'><h1>Inbound is connected</h1><p>Use the Inbound MiniApp to record. Your full report appears in Inbound on the Mac.</p></body>", headers={"Referrer-Policy": "no-referrer"})
    allowed = (path == "api/health" and request.method == "GET") or (path == "api/sessions" and request.method == "POST")
    match = re.fullmatch(r"api/sessions/([a-f0-9-]{36})(/(capture|video|process|report.json|audio|photos|notes|finish|video-state))?", path)
    relay_session = match and match[1] in config.get("sessions", [])
    local_upload = match and not relay_session and match[3] == "video" and request.method == "POST"
    if relay_session:
        methods = {None: "GET", "capture": "PUT", "video": "POST", "process": "POST", "report.json": "GET",
                   "audio": "POST", "photos": "POST", "notes": "POST", "finish": "POST", "video-state": "POST"}
        allowed = request.method == methods[match[3]]
    if not allowed and not local_upload:
        raise HTTPException(404)
    # For sessions created over Wi-Fi, the glasses can upload to a known
    # session UUID. The relay still cannot read or edit those sessions.
    maximum = 95 * 1024 * 1024
    if int(request.headers.get("content-length", "0")) > maximum:
        raise HTTPException(413, "Keep demo recordings under 95 MB.")

    async def content():
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > maximum:
                raise HTTPException(413, "Keep demo recordings under 95 MB.")
            yield chunk

    headers = {key: value for key, value in request.headers.items() if key.lower() in {"content-type", "content-length"}}
    async with httpx.AsyncClient(timeout=180) as client:
        if local_upload:
            session = await client.get(f"http://127.0.0.1:8000/api/sessions/{match[1]}")
            if not session.is_success or session.json().get("source") != "glasses":
                raise HTTPException(404)
        query = f"?{request.url.query}" if request.url.query else ""
        response = await client.request(request.method, "http://127.0.0.1:8000/" + path + query, headers=headers, content=content())
    if local_upload and response.is_success:
        return JSONResponse({"success": True, "requestId": match[1]}, headers={"Cache-Control": "no-store"})
    if path == "api/sessions" and response.status_code in {200, 201} and response.json()["id"] not in config.get("sessions", []):
        config.setdefault("sessions", []).append(response.json()["id"])
        STATE.write_text(json.dumps(config))
    return Response(response.content, status_code=response.status_code, headers={
        "Content-Type": response.headers.get("content-type", "application/json"),
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    })
