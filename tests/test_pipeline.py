import json
import shutil
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import ai
from server.main import create_app
from server.media import ffmpeg
from server.models import Report, validate_evidence
from server.store import Store


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        yield client
    app.state.processor.pool.shutdown(wait=True)


@pytest.fixture(scope="session")
def video(tmp_path_factory):
    path = tmp_path_factory.mktemp("media") / "sample.webm"
    # Streaming WebM deliberately omits a finalized container duration, like MediaRecorder.
    result = ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
                    "-t", "3", "-c:v", "libvpx", "-c:a", "libopus", "-f", "webm", "-live", "1", path)
    return path


def upload(client, path, bookmarks=None):
    session = client.post("/api/sessions", json={"title":"Test recording","source":"mac"}).json()
    assert client.put(f"/api/sessions/{session['id']}/capture", json={"bookmarks":bookmarks or []}).status_code == 200
    with path.open("rb") as data:
        assert client.post("/upload", data={"requestId":session["id"]}, files={"video":("sample.webm",data,"video/webm")}).status_code == 200
    return session["id"]


def finished(client, session_id):
    for _ in range(100):
        session = client.get(f"/api/sessions/{session_id}").json()
        if session["status"] != "processing":
            return session
        time.sleep(0.05)
    raise AssertionError("Processing did not finish")


def test_browser_webm_snaps_and_missing_key(client, video, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid = upload(client,video,[{"id":"moment","seconds":1,"label":"Snap"}])
    assert client.post(f"/api/sessions/{sid}/process").status_code == 202
    result = finished(client,sid)
    assert result["status"] == "awaiting_key"
    assert 2.9 < result["duration"] < 3.2
    assert result["report"] is None
    snap = next(item for item in result["evidence"] if item["id"] == "snap_moment")
    assert snap["start"] == 1
    for name in ["recording.mp4",snap["file"],snap["clip"]]:
        response = client.get(f"/media/{sid}/{name}",headers={"Range":"bytes=0-100"})
        assert response.status_code == 206
        assert len(response.content) == 101
    assert client.get(f"/media/{sid}/original").status_code == 404


def test_glasses_upload_keeps_snap_near_the_end(client, video, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid = client.post("/api/sessions", json={"source": "glasses", "auto_report": True}).json()["id"]
    path = f"/api/sessions/{sid}"
    bookmarks = [{"id": "mark-1", "seconds": 3.8, "label": "Snap 1"}]
    assert client.put(f"{path}/capture", json={"bookmarks": bookmarks}).status_code == 200
    with video.open("rb") as recording:
        response = client.post(f"{path}/video", files={"video": recording}, data={"requestId": "camera-id"})
    assert response.status_code == 200
    result = finished(client, sid)
    assert result["status"] == "awaiting_key"
    assert result["has_audio"]
    snap = next(item for item in result["evidence"] if item["id"] == "snap_mark-1")
    assert 2.5 < snap["start"] < result["duration"]
    assert client.get(f"/media/{sid}/{snap['file']}").status_code == 200
    assert client.get(f"/media/{sid}/{snap['clip']}").status_code == 200


def test_duplicate_upload_is_idempotent(client,video):
    sid = upload(client,video)
    with video.open("rb") as data:
        assert client.post('/upload',data={"requestId":sid},files={"video":data}).status_code == 200
    assert len(list(client.app.state.store.media_dir(sid).glob("*.part"))) == 0
    with video.open("rb") as data:
        assert client.post('/upload',data={"requestId":"unknown"},files={"video":data}).status_code == 404
    assert client.post('/upload',data={"requestId":sid},files={"video":b'other'}).status_code == 409


def test_invalid_media_and_bookmarks(client):
    sid = client.post('/api/sessions',json={}).json()['id']
    assert client.post('/upload',data={"requestId":sid},files={"video":b'not a video'}).status_code == 422
    assert client.put(f'/api/sessions/{sid}/capture',json={"bookmarks":[{"id":"../escape","seconds":1}]}).status_code == 422
    assert client.put(f'/api/sessions/{sid}/capture',json={"bookmarks":[{"id":"a","seconds":1},{"id":"a","seconds":2}]}).status_code == 422
    assert client.post(f'/api/sessions/{sid}/process').status_code == 409


def test_complete_flow_with_stubbed_ai(client,video,monkeypatch):
    # This checks our integration boundaries. It does not verify the live provider.
    monkeypatch.setenv('OPENAI_API_KEY','test-key')
    monkeypatch.setattr(ai,'transcribe',lambda path:'Training patient reports left arm pain.')
    def report(directory,evidence):
        result=Report(title='Test report',summary=[{"text":"Reported arm pain.","evidence_ids":["audio_0"]}],sections=[],timeline=[],uncertainties=[])
        return validate_evidence(result,evidence)
    monkeypatch.setattr(ai,'generate_report',report)
    sid=upload(client,video)
    client.post(f'/api/sessions/{sid}/process')
    result=finished(client,sid)
    assert result['status']=='complete'
    assert result['transcript'][0]['text']=='Training patient reports left arm pain.'
    assert client.get(f'/api/sessions/{sid}/report.json').json()['session']['report']['title']=='Test report'
    reloaded=Store(client.app.state.store.directory).get(sid)
    assert reloaded['report']==result['report']


def test_invalid_ai_evidence_is_rejected():
    result=Report(title='bad',summary=[{"text":"Claim","evidence_ids":["invented"]}],sections=[],timeline=[],uncertainties=[])
    with pytest.raises(ValueError): validate_evidence(result,[])


def test_interrupted_processing_can_resume(tmp_path):
    store=Store(tmp_path)
    session=store.create('Interrupted','mac')
    store.update(session['id'],status='processing')
    store.recover()
    assert store.get(session['id'])['status']=='interrupted'


def test_processing_claim_and_metadata_edit_are_serialized(client,video,monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY',raising=False)
    from server import media
    original=media.prepare
    started=threading.Event()
    release=threading.Event()
    calls=[]
    def slow(*args, **kwargs):
        calls.append(1);started.set();release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(media,'prepare',slow)
    sid=upload(client,video)
    client.post(f'/api/sessions/{sid}/process')
    assert started.wait(1)
    assert client.post(f'/api/sessions/{sid}/process').status_code==202
    assert client.put(f'/api/sessions/{sid}/capture',json={"bookmarks":[]}).status_code==200
    assert client.put(f'/api/sessions/{sid}/capture',json={"bookmarks":[{"id":"changed","seconds":1}]}).status_code==409
    release.set()
    assert finished(client,sid)['status']=='awaiting_key'
    assert len(calls)==1


def jpeg(color="red"):
    from io import BytesIO
    from PIL import Image
    output = BytesIO()
    Image.new("RGB", (64, 48), color).save(output, "JPEG")
    return output.getvalue()


def pcm(seconds, rate=16000):
    import base64
    import math
    samples = b"".join(int(8000 * math.sin(i / 8)).to_bytes(2, "little", signed=True) for i in range(int(seconds * rate)))
    return base64.b64encode(samples).decode()


def phone_capture(client):
    import uuid
    sid = str(uuid.uuid4())
    body = {"id": sid, "title": "Glasses capture", "source": "glasses", "auto_report": True}
    assert client.post("/api/sessions", json=body).status_code == 201
    # The phone retries a create it never saw answered.
    assert client.post("/api/sessions", json=body).status_code == 200
    path = f"/api/sessions/{sid}"
    for _ in range(2):
        assert client.post(f"{path}/audio", json={"seq": 1, "at": 0, "sample_rate": 16000, "format": "pcm16", "chunks": [pcm(1), pcm(1)]}).status_code == 200
    # The mic stream paused for a few seconds; the audio is padded to stay aligned.
    assert client.post(f"{path}/audio", json={"seq": 2, "at": 5, "sample_rate": 16000, "chunks": [pcm(1)]}).status_code == 200
    assert client.post(f"{path}/photos?seq=1&seconds=1.5", content=jpeg(), headers={"Content-Type": "image/jpeg"}).status_code == 200
    import base64
    link = "data:image/jpeg;base64," + base64.b64encode(jpeg("blue")).decode()
    assert client.post(f"{path}/photos?seq=2&seconds=5.5", json={"url": link}).status_code == 200
    assert client.post(f"{path}/notes", json={"seq": 1, "seconds": 2, "text": "BP 190 over 90 snap the forearm"}).status_code == 200
    assert client.post(f"{path}/notes", json={"seq": 1, "seconds": 2, "text": "BP 190 over 90 snap the forearm"}).status_code == 200
    live = client.get(path).json()
    assert live["status"] == "recording"
    assert "2 photos · 1 transcript lines" in live["progress"]
    return sid, path


def test_phone_capture_reaches_the_dashboard_without_a_key(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid, path = phone_capture(client)
    assert client.post(f"{path}/finish", json={"audio_parts": 2, "photos": 2, "notes": 1, "seconds": 6.2}).status_code == 200
    result = finished(client, sid)
    assert result["status"] == "awaiting_key"
    assert result["media"] == "audio" and result["has_audio"]
    assert 5.9 < result["duration"] < 6.1
    assert [item["id"] for item in result["evidence"]] == ["snap_photo-1", "snap_photo-2"]
    assert result["transcript"][0]["text"].startswith("BP 190")
    for name in ["recording.wav", "photo-1.jpg", "photo-2.jpg"]:
        assert client.get(f"/media/{sid}/{name}").status_code == 200
    # Finishing again changes nothing.
    assert client.post(f"{path}/finish", json={}).json()["status"] == "awaiting_key"


def test_phone_capture_report_uses_audio_and_photos(client, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(ai, "transcribe", lambda path: "BP 190 over 90, correction 90 over 60.")
    seen = {}
    def report(directory, evidence):
        seen["ids"] = [item["id"] for item in evidence]
        result = Report(title="Phone capture", summary=[{"text": "BP corrected to 90/60.", "evidence_ids": ["audio_0", "snap_photo-1"]}],
                        sections=[], timeline=[], uncertainties=[])
        return validate_evidence(result, evidence)
    monkeypatch.setattr(ai, "generate_report", report)
    sid, path = phone_capture(client)
    client.post(f"{path}/finish", json={"audio_parts": 2, "photos": 3, "notes": 1, "seconds": 6.2})
    result = finished(client, sid)
    assert result["status"] == "complete", result["error"]
    # The phone's line is evidence too: it records the "snap" the phone acted on.
    assert seen["ids"] == ["snap_photo-1", "snap_photo-2", "audio_0", "note_1"]
    assert "Some photos did not reach the Mac" in result["report"]["uncertainties"][0]


def test_phone_capture_rejects_bad_uploads(client):
    import uuid
    sid = str(uuid.uuid4())
    client.post("/api/sessions", json={"id": sid, "source": "glasses"})
    path = f"/api/sessions/{sid}"
    assert client.post(f"{path}/audio", json={"seq": 1, "at": 0, "format": "lc3", "chunks": ["AAAA"]}).status_code == 415
    assert client.post(f"{path}/photos?seq=1&seconds=0", content=b"not an image", headers={"Content-Type": "image/jpeg"}).status_code == 422
    assert client.post(f"{path}/photos?seq=1&seconds=0", json={"url": "http://example.com/a.jpg"}).status_code == 502
    assert client.post(f"{path}/process").status_code == 409
    assert client.post(f"{path}/finish", json={}).json()["status"] == "failed"
    assert client.post("/api/sessions", json={"id": sid, "source": "mac"}).status_code == 409
    other = client.post("/api/sessions", json={"source": "mac"}).json()["id"]
    assert client.post(f"/api/sessions/{other}/notes", json={"seq": 1, "seconds": 0, "text": "hi"}).status_code == 409


def test_internet_server_requires_the_token_or_dashboard_password(tmp_path, monkeypatch):
    import base64
    import uuid
    monkeypatch.setenv("INBOUND_DEVICE_TOKEN", "device-secret")
    monkeypatch.setenv("INBOUND_DASHBOARD_PASSWORD", "er-password")
    with TestClient(create_app(tmp_path)) as client:
        device = {"Authorization": "Bearer device-secret"}
        dashboard = {"Authorization": "Basic " + base64.b64encode(b"er:er-password").decode()}
        assert client.get("/").status_code == 401
        assert client.get("/").headers["www-authenticate"].startswith("Basic")
        assert client.get("/api/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert client.get("/api/health", headers=device).status_code == 200
        sid = str(uuid.uuid4())
        assert client.post("/api/sessions", json={"id": sid, "source": "glasses"}, headers=device).status_code == 201
        path = f"/api/sessions/{sid}"
        assert client.post(f"{path}/notes", json={"seq": 1, "seconds": 0, "text": "BP 120 over 80"}, headers=device).status_code == 200
        assert client.get(path, headers=device).status_code == 200
        # The phone's token cannot browse other captures or the dashboard.
        assert client.get("/api/sessions", headers=device).status_code == 401
        assert client.get("/static/app.js", headers=device).status_code == 401
        assert client.post(f"{path}/process", headers=device).status_code == 401
        assert client.get("/", headers=dashboard).status_code == 200
        assert client.get("/api/sessions", headers=dashboard).json()[0]["id"] == sid


def test_cloud_transcript_gets_back_the_snap_the_phone_heard():
    from server.processing import restore_snaps
    transcript = [{"text": "Suspected left forearm fracture, splinted the left forearm, no known allergies."},
                  {"text": "Applied a splint to the right leg."}]
    notes = [{"seq": 1, "seconds": 9, "text": "suspected left forearm fracture snap the left forearm"},
             {"seq": 2, "seconds": 14, "text": "applied a splint to the right leg"}]
    corrections = restore_snaps(transcript, notes)
    assert transcript[0]["text"] == "Suspected left forearm fracture, snap the left forearm, no known allergies."
    # A real splint, which the phone did not hear as "snap", is left alone.
    assert transcript[1]["text"] == "Applied a splint to the right leg."
    assert len(corrections) == 1 and '"splinted"' in corrections[0]
    # Already correct: nothing changes.
    assert restore_snaps([{"text": "Snap the left forearm."}], notes[:1]) == []
