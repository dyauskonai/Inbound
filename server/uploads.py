import time

from .auth import TUNNEL_UPLOAD


class UploadMeter:
    """Counts each video upload's bytes as they arrive, so the dashboard can show real progress.

    A Cloudflare quick tunnel holds the whole request until it is complete, so through the
    tunnel the count jumps from nothing to everything at the end. On the local network it
    moves as the glasses send.
    """

    def __init__(self, app, uploads: dict):
        self.app = app
        self.uploads = uploads

    async def __call__(self, scope, receive, send):
        match = scope["type"] == "http" and scope["method"] == "POST" and TUNNEL_UPLOAD.fullmatch(scope["path"])
        if not match:
            await self.app(scope, receive, send)
            return
        length = dict(scope.get("headers") or []).get(b"content-length", b"")
        entry = {"received": 0, "total": int(length) if length.isdigit() else None, "started": time.time()}
        self.uploads[match[1]] = entry

        async def counted():
            message = await receive()
            if message["type"] == "http.request":
                entry["received"] += len(message.get("body", b""))
            return message

        try:
            await self.app(scope, counted, send)
        finally:
            if self.uploads.get(match[1]) is entry:
                del self.uploads[match[1]]
