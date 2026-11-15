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
def client(tmp_path, monkeypatch):
    # The server loads .env; no test reaches OpenAI unless it sets a fake key and stubs the call.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    app = create_app(tmp_path, video_wait=0.3)
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
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
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
        # The ER writes to the medic; the phone reads the messages and replies, nothing more.
        question = client.post(f"{path}/messages", json={"text": "Any allergies?"}, headers=dashboard).json()
        assert client.post(f"{path}/messages", json={"text": "Any allergies?"}, headers=device).status_code == 401
        assert client.get(f"{path}/messages", headers=device).json()["messages"][0]["id"] == question["id"]
        assert client.post(f"{path}/messages/{question['id']}/heard", headers=device).status_code == 200
        assert client.post(f"{path}/replies", json={"id": str(uuid.uuid4()), "text": "None known"}, headers=device).status_code == 200


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


def test_glasses_video_fills_refused_snaps_and_shows_in_the_video_tab(client, video, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid, path = phone_capture(client)
    # The glasses confirmed video one second after Start.
    assert client.post(f"{path}/video-state", json={"state": "recording", "offset": 1.0}).status_code == 200
    # Snap 3 was refused by the camera while recording, so it waits for the video.
    finish = client.post(f"{path}/finish", json={"audio_parts": 2, "photos": 3, "notes": 1, "seconds": 6, "video_frames": [{"seq": 3, "seconds": 2.5}]})
    assert finish.json()["status"] == "waiting_video"
    assert client.post(f"{path}/video-state", json={"state": "uploading"}).status_code == 200
    with video.open("rb") as data:
        assert client.post(f"{path}/video", files={"video": ("glasses.mp4", data, "video/mp4")}, data={"requestId": "x", "type": "video_upload"}).status_code == 200
    result = finished(client, sid)
    assert result["status"] == "awaiting_key"
    assert result["video"]["state"] == "ready" and result["video"]["offset"] == 1.0 and 2.9 < result["video"]["duration"] < 3.2
    frame = next(photo for photo in result["photos"] if photo["seq"] == 3)
    assert frame["from_video"] and frame["seconds"] == 2.5
    assert "snap_photo-3" in [item["id"] for item in result["evidence"]]
    for name in ["video.mp4", "photo-3.jpg"]:
        assert client.get(f"/media/{sid}/{name}").status_code == 200
    # A retried upload of the same file is accepted without changes; the video stays separate from the audio.
    with video.open("rb") as data:
        assert client.post(f"{path}/video", files={"video": data}).status_code == 200
    assert not result["has_video"] and result["media"] == "audio"


def test_video_attached_after_the_report_adds_its_stills(client, video, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid, path = phone_capture(client)
    client.post(f"{path}/video-state", json={"state": "recording", "offset": 0.5})
    client.post(f"{path}/finish", json={"video_frames": [{"seq": 3, "seconds": 2}]})
    # The glasses could not reach the server, so the report is written without the still.
    client.post(f"{path}/video-state", json={"state": "failed", "detail": "Upload failed"})
    assert all(photo["seq"] != 3 for photo in finished(client, sid)["photos"])
    # Later someone exports the clip from the Mentra gallery and attaches it on the dashboard.
    with video.open("rb") as data:
        assert client.post(f"{path}/video", files={"video": ("gallery.mp4", data, "video/mp4")}).status_code == 200
    result = finished(client, sid)
    assert result["video"]["state"] == "ready"
    assert "snap_photo-3" in [item["id"] for item in result["evidence"]]


def test_report_does_not_wait_forever_for_a_video(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid, path = phone_capture(client)
    client.post(f"{path}/video-state", json={"state": "recording", "offset": 0.5})
    assert client.post(f"{path}/finish", json={"video_frames": [{"seq": 3, "seconds": 2}]}).json()["status"] == "waiting_video"
    time.sleep(0.5)
    result = finished(client, sid)
    assert result["status"] == "awaiting_key"
    assert all(photo["seq"] != 3 for photo in result["photos"])


def test_video_before_finish_and_failed_video(client, video, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    sid, path = phone_capture(client)
    client.post(f"{path}/video-state", json={"state": "recording", "offset": 0})
    with video.open("rb") as data:
        client.post(f"{path}/video", files={"video": data})
    # The video arrived first, so finish takes the frame from it and doesn't wait.
    assert client.post(f"{path}/finish", json={"video_frames": [{"seq": 3, "seconds": 1}]}).json()["status"] in {"processing", "awaiting_key"}
    assert any(photo["seq"] == 3 for photo in finished(client, sid)["photos"])
    other, other_path = phone_capture(client)
    client.post(f"{other_path}/video-state", json={"state": "recording", "offset": 0})
    assert client.post(f"{other_path}/finish", json={"video_frames": [{"seq": 3, "seconds": 1}]}).json()["status"] == "waiting_video"
    # The glasses report the upload failed: write the report now.
    client.post(f"{other_path}/video-state", json={"state": "failed", "detail": "Upload failed"})
    assert finished(client, other)["status"] == "awaiting_key"


def test_tunnel_lets_through_only_the_glasses_video_upload(tmp_path, video, monkeypatch):
    import uuid
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("INBOUND_PUBLIC_URL", "https://example.trycloudflare.com")
    app = create_app(tmp_path)
    with TestClient(app) as client:
        key = uuid.uuid4().hex + uuid.uuid4().hex
        sid = str(uuid.uuid4())
        # The phone, on the local network, creates the capture with its upload key.
        assert client.post("/api/sessions", json={"id": sid, "source": "glasses", "upload_token": key}).status_code == 201
        assert "upload_token" not in json.dumps(client.get(f"/api/sessions/{sid}").json()).replace("upload_token_hash", "")
        assert client.get("/api/health").json()["video_upload_url"] == "https://example.trycloudflare.com"
        tunnel = {"cf-connecting-ip": "203.0.113.9", "cf-ray": "abc"}
        upload = f"/api/sessions/{sid}/video"
        # From the internet, nothing but the upload exists.
        for method, path in [("GET", "/"), ("GET", "/api/health"), ("GET", "/api/sessions"), ("GET", f"/api/sessions/{sid}"),
                             ("POST", f"/api/sessions/{sid}/notes"), ("GET", f"/media/{sid}/recording.wav"), ("POST", "/upload")]:
            assert client.request(method, path, headers=tunnel).status_code == 404, path
        with video.open("rb") as data:
            assert client.post(upload, headers=tunnel, files={"video": data}).status_code == 404
        with video.open("rb") as data:
            assert client.post(upload, headers={**tunnel, "Authorization": "Bearer " + "0" * 64}, files={"video": data}).status_code == 404
        other = str(uuid.uuid4())
        client.post("/api/sessions", json={"id": other, "source": "glasses", "upload_token": uuid.uuid4().hex * 2})
        with video.open("rb") as data:
            # One capture's key doesn't open another capture.
            assert client.post(f"/api/sessions/{other}/video", headers={**tunnel, "Authorization": f"Bearer {key}"}, files={"video": data}).status_code == 404
        with video.open("rb") as data:
            assert client.post(upload, headers={**tunnel, "Authorization": f"Bearer {key}"}, files={"video": data}).status_code == 200
        assert client.get(f"/api/sessions/{sid}").json()["video"]["state"] == "ready"
    app.state.processor.pool.shutdown(wait=True)


def test_video_upload_check_is_kept_off_the_dashboard(client, video):
    import uuid
    sid = str(uuid.uuid4())
    assert client.post("/api/sessions", json={"id": sid, "source": "glasses", "check": True, "upload_token": uuid.uuid4().hex * 2}).status_code == 201
    with video.open("rb") as data:
        assert client.post(f"/api/sessions/{sid}/video", files={"video": data}).status_code == 200
    result = client.get(f"/api/sessions/{sid}").json()
    assert result["video"]["state"] == "ready" and result["video"]["bytes"] > 0
    assert sid not in [item["id"] for item in client.get("/api/sessions").json()]


def test_confirmed_vitals_decide_the_handoff_card(client, monkeypatch):
    import uuid
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    seen = {}

    def report(directory, evidence):
        seen["evidence"] = evidence
        from server.models import GeneratedReport
        result = GeneratedReport(
            title="Handoff", summary=[{"text": "BP reported.", "evidence_ids": ["note_1"]}], sections=[], timeline=[], uncertainties=[], snap_captions=[],
            # The model read the first, misheard value.
            handoff={"patient_age": None, "patient_sex": None, "blood_pressure": "190/60", "heart_rate": "110", "spo2": None,
                     "respiratory_rate": None, "injuries": [], "mechanism": None, "allergies": None, "eta_minutes": None,
               "consciousness": None, "treatment": [], "medications": None, "history": None,
                     "missing_fields": ["blood_pressure", "spo2", "respiratory_rate"], "evidence_ids": ["note_1"]})
        return validate_evidence(result, evidence)
    monkeypatch.setattr(ai, "generate_report", report)
    sid = str(uuid.uuid4())
    path = f"/api/sessions/{sid}"
    client.post("/api/sessions", json={"id": sid, "source": "glasses", "auto_report": True})
    client.post(f"{path}/notes", json={"seq": 1, "seconds": 1, "text": "bp one ninety over sixty correction ninety over sixty"})
    vitals = [
        {"seq": 1, "kind": "bp", "value": "190/60", "status": "heard", "seconds": 1},
        {"seq": 2, "kind": "bp", "value": "90/60", "status": "conflict", "seconds": 3, "candidates": ["190/60", "90/60"]},
        {"seq": 3, "kind": "bp", "value": "90/60", "status": "confirmed", "seconds": 8, "candidates": ["190/60", "90/60"]},
        # The read-back's echo of the same value doesn't undo the confirmation.
        {"seq": 4, "kind": "bp", "value": "90/60", "status": "heard", "seconds": 10},
        {"seq": 5, "kind": "spo2", "value": "92", "status": "heard", "seconds": 12},
        {"seq": 6, "kind": "spo2", "value": "98", "status": "conflict", "seconds": 13, "candidates": ["92", "98"]},
        {"seq": 7, "kind": "spo2", "value": "98", "status": "unconfirmed", "seconds": 40, "candidates": ["92", "98"]},
    ]
    for vital in vitals + vitals[:1]:
        assert client.post(f"{path}/vitals", json=vital).status_code == 200
    assert client.post(f"{path}/vitals", json={**vitals[0], "seq": 9, "value": "high"}).status_code == 422
    assert len(client.get(path).json()["vitals"]) == 7
    client.post(f"{path}/finish", json={"notes": 1, "seconds": 45})
    result = finished(client, sid)
    assert result["status"] == "complete", result["error"]
    texts = {item["id"]: item["text"] for item in seen["evidence"] if item["kind"] == "vital"}
    assert texts["vital_3"].startswith("Asked to repeat the blood pressure after hearing 190/60 then 90/60, the medic said 90/60.")
    card = result["report"]["handoff"]
    assert card["blood_pressure"] == "90/60" and card["confirmed_fields"] == ["blood_pressure"]
    assert card["spo2"] == "92% or 98% (unconfirmed)" and card["unconfirmed_fields"] == ["spo2"]
    assert card["missing_fields"] == ["respiratory_rate"]
    assert "vital_3" in card["evidence_ids"] and "vital_7" in card["evidence_ids"]
    assert result["report"]["uncertainties"][0].startswith("The oxygen saturation is unconfirmed: the medic gave 92% and 98%")


def test_a_later_new_reading_is_left_to_the_report(client, monkeypatch):
    from server.processing import apply_vitals
    report = {"uncertainties": [], "handoff": {"blood_pressure": "100/70", "missing_fields": [], "evidence_ids": []}}
    apply_vitals(report, [
        {"seq": 1, "kind": "bp", "value": "90/60", "status": "confirmed", "seconds": 8, "candidates": ["190/60", "90/60"]},
        {"seq": 2, "kind": "bp", "value": "100/70", "status": "heard", "seconds": 600, "candidates": []},
    ])
    assert report["handoff"]["blood_pressure"] == "100/70" and report["handoff"]["confirmed_fields"] == []


def test_an_unclear_vital_stays_unclear_on_the_card(client):
    import uuid
    from server.processing import apply_vitals
    sid = str(uuid.uuid4())
    client.post("/api/sessions", json={"id": sid, "source": "glasses"})
    unclear = {"seq": 1, "kind": "bp", "value": "90/60", "status": "unconfirmed", "seconds": 5, "candidates": ["90/60", "unclear"]}
    assert client.post(f"/api/sessions/{sid}/vitals", json=unclear).status_code == 200
    only_unclear = {"seq": 2, "kind": "hr", "value": "", "status": "conflict", "seconds": 6, "candidates": ["unclear"]}
    assert client.post(f"/api/sessions/{sid}/vitals", json=only_unclear).status_code == 200
    assert client.post(f"/api/sessions/{sid}/vitals", json={**only_unclear, "seq": 3, "candidates": ["garbage"]}).status_code == 422
    report = {"uncertainties": [], "handoff": {"blood_pressure": "190/60", "heart_rate": None, "missing_fields": [], "evidence_ids": []}}
    apply_vitals(report, client.get(f"/api/sessions/{sid}").json()["vitals"])
    assert report["handoff"]["blood_pressure"] == "90/60 or unclear (unconfirmed)"
    assert report["handoff"]["heart_rate"] == "unclear (unconfirmed)"


def test_a_vital_the_medic_changes_later_replaces_the_confirmed_one():
    from server.processing import apply_vitals, vital_evidence
    vitals = [
        {"seq": 1, "kind": "hr", "value": "110", "status": "confirmed", "seconds": 8, "candidates": ["100", "110"]},
        {"seq": 2, "kind": "hr", "value": "125", "status": "updated", "seconds": 300, "candidates": ["110", "125"]},
        # The read-back's echo, same value.
        {"seq": 3, "kind": "hr", "value": "125", "status": "heard", "seconds": 302, "candidates": []},
    ]
    report = {"uncertainties": [], "handoff": {"heart_rate": "110", "missing_fields": [], "evidence_ids": []}}
    apply_vitals(report, vitals)
    assert report["handoff"]["heart_rate"] == "125" and report["handoff"]["updated_fields"] == ["heart_rate"]
    assert report["handoff"]["confirmed_fields"] == []
    assert vital_evidence(vitals[1])["text"] == "The medic changed the heart rate from 110 to 125, and Inbound read it back. This replaces the earlier value."


def test_invented_citations_are_dropped_instead_of_failing_the_report():
    from server.models import GeneratedReport
    evidence = [{"id": "audio_0", "kind": "transcript", "start": 0, "end": 30},
                {"id": "snap_photo-1", "kind": "image", "start": 4, "end": 4, "file": "photo-1.jpg"}]
    handoff = {"patient_age": None, "patient_sex": None, "blood_pressure": None, "heart_rate": None, "spo2": None,
               "respiratory_rate": None, "injuries": [], "mechanism": None, "allergies": None, "eta_minutes": None,
               "consciousness": None, "treatment": [], "medications": None, "history": None,
               "missing_fields": [], "evidence_ids": ["audio_0", "vital_99"]}
    report = GeneratedReport(
        title="t", summary=[{"text": "Supported.", "evidence_ids": ["audio_0", "photo_1"]}, {"text": "Invented.", "evidence_ids": ["note_9"]}],
        sections=[{"heading": "Vitals", "statements": [{"text": "Invented.", "evidence_ids": ["vital_99"]}]}],
        timeline=[], uncertainties=[], snap_captions=[], handoff=handoff)
    result = validate_evidence(report, evidence)
    assert [item["text"] for item in result["summary"]] == ["Supported."]
    assert result["summary"][0]["evidence_ids"] == ["audio_0"]
    assert result["sections"] == []
    assert result["handoff"]["evidence_ids"] == ["audio_0"]
    assert result["snap_captions"] == [{"evidence_id": "snap_photo-1", "caption": "The AI did not describe this photo."}]
    assert result["uncertainties"] == ["2 statements were left out because they cited no supplied evidence."]


def test_report_generation_retries_once_when_nothing_is_supported(monkeypatch):
    from types import SimpleNamespace
    from server.models import GeneratedReport
    handoff = {"patient_age": None, "patient_sex": None, "blood_pressure": None, "heart_rate": None, "spo2": None,
               "respiratory_rate": None, "injuries": [], "mechanism": None, "allergies": None, "eta_minutes": None,
               "consciousness": None, "treatment": [], "medications": None, "history": None,
               "missing_fields": [], "evidence_ids": []}
    replies = [GeneratedReport(title="t", summary=[{"text": "x", "evidence_ids": ["nope"]}], sections=[], timeline=[], uncertainties=[], snap_captions=[], handoff=handoff),
               GeneratedReport(title="t", summary=[{"text": "y", "evidence_ids": ["audio_0"]}], sections=[], timeline=[], uncertainties=[], snap_captions=[], handoff=handoff)]
    calls = []
    fake = SimpleNamespace(responses=SimpleNamespace(parse=lambda **kwargs: calls.append(1) or SimpleNamespace(output_parsed=replies[len(calls) - 1])))
    monkeypatch.setattr(ai, "client", lambda: fake)
    report = ai.generate_report(Path("."), [{"id": "audio_0", "kind": "transcript", "start": 0, "end": 30}])
    assert len(calls) == 2 and report["summary"][0]["text"] == "y"


def test_sample_patient_fills_the_dashboard_and_stays_current(client):
    sample = client.post("/api/sample").json()
    assert sample["source"] == "sample" and sample["status"] == "complete"
    handoff = sample["report"]["handoff"]
    assert handoff["confirmed_fields"] == ["blood_pressure"] and handoff["updated_fields"] == ["heart_rate"]
    assert [vital["status"] for vital in sample["vitals"] if vital["kind"] == "hr"] == ["heard", "updated"]
    # Every source the report cites exists, so each one on the dashboard opens something.
    report = sample["report"]
    cited = {source for item in [*report["summary"], *report["timeline"], handoff, *(s for section in report["sections"] for s in section["statements"])]
             for source in item["evidence_ids"]}
    assert cited <= {item["id"] for item in sample["evidence"]}
    assert {caption["evidence_id"] for caption in report["snap_captions"]} == {item["id"] for item in sample["evidence"] if item["id"].startswith("snap_")}
    assert client.post("/api/sample").json()["id"] == sample["id"]
    # An outdated sample makes way for a fresh one and leaves the board.
    client.app.state.store.update(sample["id"], sample_version=1)
    fresh = client.post("/api/sample").json()
    assert fresh["id"] != sample["id"]
    assert [item["id"] for item in client.get("/api/sessions").json() if item["source"] == "sample"] == [fresh["id"]]


def test_upload_meter_counts_video_bytes_as_they_arrive():
    import asyncio
    from server.uploads import UploadMeter
    sid, uploads, seen = "0a1b2c3d-0000-4000-8000-000000000000", {}, []

    async def app(scope, receive, send):
        while (await receive())["more_body"]:
            seen.append(dict(uploads[sid]))
    messages = iter([{"type": "http.request", "body": b"a" * 400, "more_body": True},
                     {"type": "http.request", "body": b"b" * 600, "more_body": False}])

    async def receive():
        return next(messages)
    scope = {"type": "http", "method": "POST", "path": f"/api/sessions/{sid}/video", "headers": [(b"content-length", b"1000")]}
    asyncio.run(UploadMeter(app, uploads)(scope, receive, None))
    assert (seen[0]["received"], seen[0]["total"]) == (400, 1000)
    assert sid not in uploads


def test_dashboard_estimates_a_video_upload_the_tunnel_hides(client):
    import uuid
    sid = str(uuid.uuid4())
    assert client.post("/api/sessions", json={"id": sid, "source": "glasses"}).status_code == 201
    assert client.post(f"/api/sessions/{sid}/video-state", json={"state": "recording", "offset": 1.5}).status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["video_upload"] is None
    assert client.post(f"/api/sessions/{sid}/video-state", json={"state": "uploading"}).status_code == 200
    upload = client.get(f"/api/sessions/{sid}").json()["video_upload"]
    assert upload["mode"] == "estimated" and upload["total"] > 0 and upload["rate"] > 0 and upload["since"]
    assert next(card for card in client.get("/api/sessions").json() if card["id"] == sid)["video_upload"] == upload
    # A repeated "uploading" keeps the time the upload began.
    client.post(f"/api/sessions/{sid}/video-state", json={"state": "uploading"})
    assert client.get(f"/api/sessions/{sid}").json()["video_upload"]["since"] == upload["since"]


def test_the_er_and_the_medic_message_about_a_capture(client):
    import uuid
    sid = str(uuid.uuid4())
    assert client.post("/api/sessions", json={"id": sid, "source": "glasses"}).status_code == 201
    sent = client.post(f"/api/sessions/{sid}/messages", json={"text": " Can you send a closer photo of the left forearm? "})
    assert sent.status_code == 201
    question = sent.json()
    assert (question["from"], question["text"], question["heard_at"]) == ("er", "Can you send a closer photo of the left forearm?", None)
    # The glasses read it aloud; the medic answers with a photo and words, which can arrive in either order.
    assert client.post(f"/api/sessions/{sid}/messages/{question['id']}/heard").status_code == 200
    answer = str(uuid.uuid4())
    assert client.post(f"/api/sessions/{sid}/replies/{answer}/photo", content=jpeg(), headers={"Content-Type": "image/jpeg"}).status_code == 200
    for _ in range(2):
        assert client.post(f"/api/sessions/{sid}/replies", json={"id": answer, "text": "Swelling now reaches the wrist.", "reply_to": question["id"]}).status_code == 200
    messages = client.get(f"/api/sessions/{sid}/messages").json()["messages"]
    assert [message["from"] for message in messages] == ["er", "medic"]
    assert messages[0]["heard_at"]
    assert (messages[1]["text"], messages[1]["reply_to"], messages[1]["photo"]) == ("Swelling now reaches the wrist.", question["id"], f"reply-{answer}.jpg")
    assert client.get(f"/media/{sid}/reply-{answer}.jpg").status_code == 200
    card = next(card for card in client.get("/api/sessions").json() if card["id"] == sid)
    assert (card["message_count"], card["reply_count"]) == (2, 1)
    # Only a capture from the glasses has a medic to ask, and message IDs are checked.
    imported = client.post("/api/sessions", json={"title": "Imported", "source": "upload"}).json()
    assert client.post(f"/api/sessions/{imported['id']}/messages", json={"text": "Hello"}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/messages/not-an-id/heard").status_code == 404
    assert client.post(f"/api/sessions/{sid}/replies/{question['id']}", json={}).status_code in (404, 405)
    assert client.post(f"/api/sessions/{sid}/replies", json={"id": question["id"], "text": "overwrite"}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/replies/{answer}/photo", content=b"not an image", headers={"Content-Type": "image/jpeg"}).status_code == 422


def test_a_reply_updates_the_vitals_and_fills_in_the_handoff_card(client, monkeypatch):
    import time
    import uuid
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(ai, "read_reply", lambda question, heard, card: {"answer": "BP is now 100/80. Resp rate 18.", "handoff": {
        "patient_age": None, "patient_sex": None, "mechanism": None, "injuries": ["Abrasions to both knees"], "consciousness": None,
        "treatment": [], "allergies": "Penicillin", "medications": None, "history": None, "eta_minutes": 5}})
    sid = str(uuid.uuid4())
    assert client.post("/api/sessions", json={"id": sid, "source": "glasses"}).status_code == 201
    client.app.state.store.update(
        sid, capture_seconds=40, vitals=[{"seq": 1, "kind": "bp", "value": "120/80", "status": "confirmed", "seconds": 5, "candidates": ["120/80"]}],
        report={"title": "Car accident", "summary": [], "sections": [], "timeline": [], "uncertainties": [],
                "handoff": {"blood_pressure": "120/80", "respiratory_rate": None, "injuries": ["Scalp laceration"], "allergies": None,
                            "confirmed_fields": ["blood_pressure"], "missing_fields": ["respiratory_rate", "allergies"]}})
    question = client.post(f"/api/sessions/{sid}/messages", json={"text": "Can you give me an updated set of vitals?"}).json()
    answer = {"id": str(uuid.uuid4()), "text": "yeah it's one hundred over eighty now, resp rate eighteen", "reply_to": question["id"],
              "heard": "from the er can you give me an updated set of idols go ahead yeah it's one hundred over eighty now, resp rate eighteen",
              "vitals": [{"kind": "bp", "value": "100/80"}, {"kind": "rr", "value": "18"}]}
    for _ in range(2):  # A retried reply logs nothing twice.
        assert client.post(f"/api/sessions/{sid}/replies", json=answer).status_code == 200
    session = client.get(f"/api/sessions/{sid}").json()
    assert [(vital["seq"], vital["kind"], vital["value"], vital["status"], vital["candidates"]) for vital in session["vitals"]] == [
        (1, "bp", "120/80", "confirmed", ["120/80"]), (2, "bp", "100/80", "updated", ["120/80"]), (3, "rr", "18", "updated", [])]
    handoff = session["report"]["handoff"]
    assert (handoff["blood_pressure"], handoff["respiratory_rate"]) == ("100/80", "18")
    assert (handoff["updated_fields"], handoff["confirmed_fields"], handoff["missing_fields"]) == (["blood_pressure", "respiratory_rate"], [], [])
    # The AI's tidy version is for reading; the words as heard stay beside it.
    for _ in range(100):
        reply = client.get(f"/api/sessions/{sid}/messages").json()["messages"][-1]
        if reply.get("clean"):
            break
        time.sleep(0.02)
    assert reply["clean"] == "BP is now 100/80. Resp rate 18."
    assert reply["heard"].startswith("from the er") and reply["text"].startswith("yeah")
    # What the medic said fills in the handoff card, marked with the reply it came from.
    handoff = client.get(f"/api/sessions/{sid}").json()["report"]["handoff"]
    assert handoff["injuries"] == ["Scalp laceration", "Abrasions to both knees"] and handoff["allergies"] == "Penicillin"
    assert handoff["missing_fields"] == [] and handoff["eta_minutes"] == 5 and handoff["eta_at"]
    assert set(handoff["reply_sources"]) == {"injuries", "allergies", "eta_minutes"} and handoff["reply_sources"]["allergies"]["id"] == answer["id"]
    assert reply["added"] == {"injuries": ["Abrasions to both knees"], "allergies": "Penicillin", "eta_minutes": 5}
    # A rewritten report keeps it: the processor applies the replies again.
    from server.processing import apply_reply_updates
    fresh = {"handoff": {"injuries": ["Scalp laceration"], "allergies": None, "missing_fields": ["allergies"]}}
    apply_reply_updates(fresh, client.get(f"/api/sessions/{sid}").json()["handoff_updates"])
    assert fresh["handoff"]["injuries"] == ["Scalp laceration", "Abrasions to both knees"] and fresh["handoff"]["missing_fields"] == []
    # Saying the same value again is not a change.
    client.post(f"/api/sessions/{sid}/replies", json={**answer, "id": str(uuid.uuid4()), "vitals": [{"kind": "bp", "value": "100/80"}]})
    assert len(client.get(f"/api/sessions/{sid}").json()["vitals"]) == 3


def test_the_doctor_can_dictate_a_message(client, monkeypatch):
    assert client.post("/api/dictation", files={"audio": ("dictation", b"audio", "audio/mp4")}).status_code == 503
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    heard = []
    monkeypatch.setattr(ai, "dictate", lambda path: heard.append(path.suffix) or "Does the patient have any allergies?")
    # Safari records AAC in an MP4 box; the transcription service needs to know that from the name.
    reply = client.post("/api/dictation", files={"audio": ("dictation", b"audio", "audio/mp4")})
    assert reply.json() == {"text": "Does the patient have any allergies?"} and heard == [".m4a"]
    assert client.post("/api/dictation", files={"audio": ("dictation", b"", "audio/webm")}).status_code == 422
