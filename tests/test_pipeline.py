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
    sid = client.post("/api/sessions", json={"source": "glasses"}).json()["id"]
    path = f"/api/sessions/{sid}"
    bookmarks = [{"id": "mark-1", "seconds": 3.8, "label": "Snap 1"}]
    assert client.put(f"{path}/capture", json={"bookmarks": bookmarks}).status_code == 200
    with video.open("rb") as recording:
        response = client.post(f"{path}/video", files={"video": recording}, data={"requestId": "camera-id"})
    assert response.status_code == 200
    assert client.post(f"{path}/process").status_code == 202
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
