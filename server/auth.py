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
    ("POST", re.compile(SESSION + r"/(?:audio|photos|notes|finish|video|video-state)")),
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
