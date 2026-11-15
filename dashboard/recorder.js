const $ = (id) => document.getElementById(id);
const formatTime = (value) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

async function savedCapture(operation, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("inbound-recordings", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("pending");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      "pending",
      operation === "get" ? "readonly" : "readwrite",
    );
    const store = transaction.objectStore("pending");
    let request;
    if (operation === "get") request = store.get("recording");
    if (operation === "put") request = store.put(value, "recording");
    if (operation === "delete") request = store.delete("recording");
    transaction.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

export function setupRecorder({ api, selectSession }) {
  let stream, context, socket, processor, recorder;
  let state = "off";
  let recordingStart = 0;
  let audioStart = 0;
  let marks = [];
  let chunks = [];
  let bytes = 0;
  let pending = null;
  let timer = null;

  function status(next, message) {
    state = next;
    $("capture-state").textContent = {
      off: "Camera is off",
      opening: "Connecting camera",
      armed: "Ready for “start recording”",
      starting: "Starting",
      recording: "Recording",
      saving: "Saving recording",
      uploading: "Uploading",
      pending: "Recording saved locally",
    }[next];
    $("capture-message").textContent = message;
    $("enable-camera").hidden = next !== "off";
    $("start-capture").hidden = next !== "armed";
    $("snap-capture").hidden = $("stop-capture").hidden = next !== "recording";
    $("save-capture").hidden = $("download-capture").hidden =
      next !== "pending";
    $("close-record").disabled = [
      "starting",
      "recording",
      "saving",
      "uploading",
    ].includes(next);
  }

  function error(value) {
    $("capture-error").textContent = value.message;
    $("capture-error").hidden = false;
  }
  function releaseCamera() {
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    processor?.disconnect();
    void context?.close();
    context = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  async function openRecorder() {
    $("capture-error").hidden = true;
    $("record-dialog").showModal();
    try {
      pending = (await savedCapture("get")) || pending;
      if (pending)
        status(
          "pending",
          "An unsent recording was recovered from this browser. Upload it or download a copy.",
        );
    } catch (value) {
      error(value);
    }
  }

  async function enableCamera() {
    status(
      "opening",
      "Allow camera and microphone access to record a training scenario.",
    );
    $("capture-error").hidden = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      $("camera-preview").srcObject = stream;
      await $("camera-preview").play();
      status("armed", "Say “start recording”, or use the controls below.");
      await startVoice();
    } catch (value) {
      if (!stream) {
        releaseCamera();
        status("off", "Enable the camera and microphone to try again.");
      }
      error(value);
    }
  }

  async function startVoice() {
    const health = await api("/api/health");
    if (!health.local_voice_ready)
      throw new Error(
        "The local voice model needs setup. Manual recording controls are available.",
      );
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/voice`,
    );
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Voice recognition connection timed out. Manual controls remain available.",
            ),
          ),
        10000,
      );
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.ready) {
          clearTimeout(timeout);
          resolve();
        }
        if (data.error) {
          clearTimeout(timeout);
          reject(new Error(data.error));
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect local voice recognition."));
      };
    });
    await ready;
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.heard)
        $("capture-message").textContent = `Heard “${data.heard}”`;
      for (const { command, end } of data.commands || []) {
        if (command === "start" && state === "armed") void startRecording();
        if (command === "snap" && state === "recording")
          snap(
            end == null
              ? undefined
              : Math.max(0, (audioStart + end * 1000 - recordingStart) / 1000),
          );
        if (command === "stop" && state === "recording") stopRecording();
      }
    };
    socket.onclose = () =>
      error(
        new Error(
          "Voice recognition disconnected. Use the recording buttons to finish.",
        ),
      );
    context = new AudioContext();
    await context.audioWorklet.addModule("/static/pcm-worklet.js");
    const source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, "pcm-capture");
    const muted = context.createGain();
    muted.gain.value = 0;
    processor.port.onmessage = (event) => {
      if (
        socket?.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < 160000
      )
        socket.send(event.data);
    };
    audioStart = performance.now();
    source.connect(processor);
    processor.connect(muted);
    muted.connect(context.destination);
    await context.resume();
  }

  async function startRecording() {
    if (state !== "armed") return;
    status("starting", "Preparing the recording.");
    try {
      const session = await api("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Mac recording · ${new Date().toLocaleTimeString()}`,
          source: "mac",
        }),
      });
      const mimeType = [
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, videoBitsPerSecond: 2200000 } : {},
      );
      chunks = [];
      marks = [];
      bytes = 0;
      $("capture-marks").replaceChildren();
      pending = {
        id: session.id,
        started_at: new Date().toISOString(),
        bookmarks: [],
        mime: recorder.mimeType,
      };
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes > 480 * 1024 * 1024 && state === "recording") {
          error(new Error("Recording stopped near the local file-size limit."));
          stopRecording();
        }
      };
      recorder.onerror = (event) => {
        error(event.error || new Error("Recording was interrupted."));
        if (state === "recording") stopRecording();
      };
      recorder.onstop = () => void finishRecording();
      recorder.onstart = () => {
        recordingStart = performance.now();
        status(
          "recording",
          "Say “snap” to mark a moment, then “stop recording” to finish.",
        );
        timer = setInterval(() => {
          $("capture-timer").textContent = formatTime(
            (performance.now() - recordingStart) / 1000,
          );
        }, 250);
      };
      recorder.start(1000);
    } catch (value) {
      status("armed", "Recording could not start. Try again.");
      error(value);
    }
  }

  function snap(seconds = (performance.now() - recordingStart) / 1000) {
    if (state !== "recording" || marks.length >= 40) return;
    const item = {
      id: crypto.randomUUID(),
      seconds,
      label: `Snap ${marks.length + 1}`,
    };
    marks.push(item);
    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 126;
    canvas.getContext("2d").drawImage($("camera-preview"), 0, 0, 224, 126);
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = canvas.toDataURL("image/jpeg");
    image.alt = item.label;
    const caption = document.createElement("figcaption");
    caption.textContent = `${item.label} · ${formatTime(seconds)}`;
    figure.append(image, caption);
    $("capture-marks").append(figure);
    $("capture-message").textContent =
      `Marked ${item.label.toLowerCase()} at ${formatTime(seconds)}.`;
  }

  function stopRecording() {
    if (state !== "recording") return;
    status("saving", "Saving your recording and marked moments.");
    clearInterval(timer);
    recorder.stop();
  }

  async function finishRecording() {
    releaseCamera();
    pending.blob = new Blob(chunks, { type: pending.mime });
    pending.bookmarks = [...marks];
    chunks = [];
    try {
      await savedCapture("put", pending);
    } catch (value) {
      error(
        new Error(
          "Browser storage is full. Keep this page open until upload completes, or download the recording.",
        ),
      );
    }
    await uploadRecording();
  }

  async function uploadRecording() {
    if (!pending?.blob) return;
    status("uploading", "Sending the recording to your local Inbound server.");
    try {
      await api(`/api/sessions/${pending.id}/capture`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookmarks: pending.bookmarks,
          started_at: pending.started_at,
        }),
      });
      const form = new FormData();
      form.append(
        "video",
        pending.blob,
        pending.mime.includes("mp4") ? "recording.mp4" : "recording.webm",
      );
      await api(`/api/sessions/${pending.id}/video`, {
        method: "POST",
        body: form,
      });
      await api(`/api/sessions/${pending.id}/process`, { method: "POST" });
      const id = pending.id;
      await savedCapture("delete");
      pending = null;
      status("off", "Recording saved. You can start another session.");
      $("record-dialog").close();
      await selectSession(id);
    } catch (value) {
      status(
        "pending",
        "Recording is saved in this browser. Retry the upload or download a copy.",
      );
      error(value);
    }
  }

  $("download-capture").onclick = () => {
    const url = URL.createObjectURL(pending.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `inbound-${pending.id}.${pending.mime.includes("mp4") ? "mp4" : "webm"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("enable-camera").onclick = enableCamera;
  $("start-capture").onclick = startRecording;
  $("snap-capture").onclick = () => snap();
  $("stop-capture").onclick = stopRecording;
  $("save-capture").onclick = uploadRecording;
  $("close-record").onclick = () => $("record-dialog").close();
  $("record-dialog").addEventListener("cancel", (event) => {
    if (["recording", "starting", "saving", "uploading"].includes(state))
      event.preventDefault();
  });
  $("record-dialog").addEventListener("close", () => {
    releaseCamera();
    if (state !== "pending") status("off", "Enable the camera to begin.");
  });
  window.addEventListener("beforeunload", (event) => {
    if (["recording", "starting", "saving", "uploading"].includes(state)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  // The dashboard's own buttons open the recorder.
  return { open: openRecorder };
}
