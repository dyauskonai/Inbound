import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, directory: Path):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.database = directory / "inbound.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)")

    def connect(self):
        return sqlite3.connect(self.database, timeout=10)

    def create(self, title: str, source: str, session_id: str | None = None) -> dict:
        session = {
            "id": session_id or str(uuid4()), "title": title, "source": source,
            "created_at": now(), "updated_at": now(), "status": "created",
            "progress": "Waiting for a recording", "error": None,
            "bookmarks": [], "evidence": [], "transcript": [], "report": None,
            "duration": None, "has_video": False, "has_audio": False,
        }
        with self.connect() as db:
            db.execute("INSERT INTO sessions VALUES (?, ?)", (session["id"], json.dumps(session)))
        self.media_dir(session["id"]).mkdir(exist_ok=True)
        return session

    def get(self, session_id: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT data FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            raise KeyError(session_id)
        return json.loads(row[0])

    def list(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT data FROM sessions").fetchall()
        return sorted((json.loads(row[0]) for row in rows), key=lambda item: item["created_at"], reverse=True)

    def update(self, session_id: str, **changes) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None:
                raise KeyError(session_id)
            value = json.loads(row[0])
            value.update(changes, updated_at=now())
            db.execute("UPDATE sessions SET data = ? WHERE id = ?", (json.dumps(value), session_id))
        return value

    def media_dir(self, session_id: str) -> Path:
        # Resolve only IDs already present in the database.
        self.get(session_id)
        return self.directory / session_id

    def recover(self):
        for session in self.list():
            if session["status"] == "processing":
                self.update(session["id"], status="interrupted", progress="Processing interrupted. Retry to resume.")
            if session.get("live_state") in {"waiting", "recording"} and not session["has_video"]:
                self.update(session["id"], live_state="failed", error="The Mac server restarted during capture.",
                            progress="Start a new glasses recording.")
