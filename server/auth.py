"""Access control for a server reachable from the internet.

Off when neither secret is set, so the local laptop demo works as before.
The glasses MiniApp sends a bearer token and may only create captures,
upload to them, and check their status. People sign in to the dashboard
with a shared password (HTTP Basic, so the page, live updates, and media
all reuse one browser login).
"""
import base64
import binascii
import hmac
import json
import re

SESSION = r"/api/sessions/[a-f0-9-]{36}"
DEVICE_ROUTES = [
    ("GET", re.compile(r"/api/health")),
    ("POST", re.compile(r"/api/sessions")),
    ("GET", re.compile(SESSION)),
    # The glasses upload their video themselves, with the token the MiniApp gives them.
    ("POST", re.compile(SESSION + r"/(?:audio|photos|notes|vitals|finish|video|video-state)")),
    # The ER's messages to the medic, and the medic's replies.
    ("GET", re.compile(SESSION + r"/messages")),
    ("POST", re.compile(SESSION + r"/messages/[a-f0-9-]{36}/heard")),
    ("POST", re.compile(SESSION + r"/replies(?:/[a-f0-9-]{36}/photo)?")),
]


def matches(secret: str | None, value: str) -> bool:
    return bool(secret) and hmac.compare_digest(value.encode(), secret.encode())


class AccessControl:
    def __init__(self, app, device_token: str | None = None, dashboard_password: str | None = None):
        self.app = app
        self.device_token = device_token
        self.dashboard_password = dashboard_password

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"} or not (self.device_token or self.dashboard_password) or self.allowed(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({"type": "http.response.start", "status": 401, "headers": [
            (b"content-type", b"application/json"),
            (b"www-authenticate", b'Basic realm="Inbound", charset="UTF-8"'),
        ]})
        await send({"type": "http.response.body", "body": json.dumps({"detail": "Sign in to Inbound."}).encode()})

    def allowed(self, scope) -> bool:
        header = dict(scope["headers"]).get(b"authorization", b"").decode("latin-1")
        scheme, _, value = header.partition(" ")
        if scheme.lower() == "basic":
            try:
                password = base64.b64decode(value, validate=True).decode().partition(":")[2]
            except (binascii.Error, UnicodeDecodeError):
                return False
            return matches(self.dashboard_password, password)
        if scheme.lower() == "bearer" and matches(self.device_token, value.strip()):
            method = scope.get("method", "GET")
            return any(method == allowed and route.fullmatch(scope["path"]) for allowed, route in DEVICE_ROUTES)
        return False


TUNNEL_UPLOAD = re.compile(r"/api/sessions/([a-f0-9-]{36})/video")


class TunnelGuard:
    """Through the laptop's Cloudflare tunnel, allow only the glasses' video upload.

    cloudflared connects from this machine, so tunnel requests are told apart by the
    header Cloudflare adds to every request it forwards. An upload must carry the
    secret the phone made for that capture, checked before the body is read. Anything
    else gets a plain 404, so the dashboard and captures never reach the internet.
    """

    def __init__(self, app, verify):
        self.app = app
        self.verify = verify

    async def __call__(self, scope, receive, send):
        headers = dict(scope.get("headers") or [])
        if scope["type"] not in {"http", "websocket"} or not (b"cf-connecting-ip" in headers or b"cf-ray" in headers):
            await self.app(scope, receive, send)
            return
        scheme, _, token = headers.get(b"authorization", b"").decode("latin-1").partition(" ")
        match = TUNNEL_UPLOAD.fullmatch(scope["path"])
        if scope["type"] == "http" and scope["method"] == "POST" and match and scheme.lower() == "bearer" and self.verify(match[1], token.strip()):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({"type": "http.response.start", "status": 404, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"detail":"Not Found"}'})
