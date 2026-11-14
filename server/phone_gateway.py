"""Temporary token-protected phone gateway. Bind to loopback behind HTTPS."""
import hmac
import json
import re
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

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
    paths = {
        "miniapp.json": ROOT / "app/miniapp.json",
        "icon.png": ROOT / "app/icon.png",
        "bundle.zip": ROOT / "app/build/com.inbound.capture-0.1.0.zip",
    }
    path = paths.get(filename)
    if path is None or not path.is_file():
        raise HTTPException(404)
    if filename == "bundle.zip":
        print("Phone downloaded the Inbound install bundle", flush=True)
    return FileResponse(path, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@app.api_route("/device/{token}/{path:path}", methods=["GET", "POST", "PUT"])
async def device(token: str, path: str, request: Request):
    authenticate(token)
    if not path:
        return HTMLResponse("<body style='font:18px system-ui;padding:30px'><h1>Inbound is connected</h1><p>Use the Inbound MiniApp to record. Your full report appears in Inbound on the Mac.</p></body>", headers={"Referrer-Policy": "no-referrer"})
    allowed = (path == "api/health" and request.method == "GET") or (path == "api/sessions" and request.method == "POST")
    match = re.fullmatch(r"api/sessions/([a-f0-9-]{36})(/(capture|video|process|report.json))?", path)
    if match and match[1] in config.get("sessions", []):
        methods = {None: "GET", "capture": "PUT", "video": "POST", "process": "POST", "report.json": "GET"}
        allowed = request.method == methods[match[3]]
    if not allowed:
        raise HTTPException(404)
    # Only sessions made by this phone connection are reachable. The tunnel
    # cannot enumerate existing recordings, files, or server credentials.
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
        response = await client.request(request.method, "http://127.0.0.1:8000/" + path, headers=headers, content=content())
    if path == "api/sessions" and response.status_code == 201:
        config.setdefault("sessions", []).append(response.json()["id"])
        STATE.write_text(json.dumps(config))
    return Response(response.content, status_code=response.status_code, headers={
        "Content-Type": response.headers.get("content-type", "application/json"),
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    })
