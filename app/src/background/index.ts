import { registerMiniapp } from "@mentra/miniapp/background";
import type { Capture, Channels, Command, State } from "../shared/channels";
import { commandFrom, serverOrigin } from "../shared/commands";

declare const INBOUND_SERVER: string;

registerMiniapp<Channels>(async (session) => {
  const state: State = {
    phase: "ready", server: INBOUND_SERVER, online: false, aiConfigured: false,
    camera: false, connected: false, wifi: false, battery: null,
    voice: "Waiting for the on-device speech model", heard: "",
    message: "Say “start recording” or connect to the Mac below.", error: "", capture: null, busy: false,
  };
  let polling = false;
  let hydrated = false;
  let stopQueued = false;
  let lastCommand = "";
  let lastCommandAt = 0;
  const publish = () => session.ui.send("state", { ...state });
  const save = async () => {
    if (state.capture) {
      state.capture.phase = state.phase;
      await session.storage.set("capture", JSON.stringify(state.capture));
    }
  };
  const problem = (error: unknown) => {
    state.error = error instanceof Error ? error.message : String((error as {message?: string})?.message || error);
    publish();
  };

  async function api<T>(path: string, body?: unknown, method = "GET"): Promise<T> {
    const base = state.capture && state.phase !== "complete" ? state.capture.server : state.server;
    if (!base) throw new Error("Enter the Mac server address first.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(base + path, {
        method, signal: controller.signal,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Mac server returned ${response.status}`);
      state.online = true;
      return data as T;
    } catch (error) { state.online = false; throw error; }
    finally { clearTimeout(timer); }
  }

  async function syncCapture() {
    const capture = state.capture;
    if (!capture) return;
    await api(`/api/sessions/${capture.id}/capture`, {
      bookmarks: capture.bookmarks,
      started_at: new Date(capture.startedAt).toISOString(),
    }, "PUT");
  }

  async function start() {
    if (!["ready", "complete"].includes(state.phase)) return;
    if (!session.capabilities?.hasCamera) throw new Error("Connect Mentra Live glasses in the Mentra app first.");
    const previous = state.capture;
    state.capture = null;
    state.phase = "starting";
    state.message = "Starting the glasses camera…";
    publish();
    let cameraRequested = false;
    try {
      const result = await api<{id: string}>("/api/sessions", {
        title: `Glasses recording · ${new Date().toLocaleTimeString()}`, source: "glasses",
      }, "POST");
      state.capture = { id: result.id, startedAt: Date.now(), bookmarks: [], phase: "starting", server: state.server };
      await save();
      cameraRequested = true;
      const recording = await session.camera.startVideoRecording({ save: true, sound: true });
      if (!recording?.recordingId) throw new Error("The glasses did not return a recording ID.");
      state.capture.recordingId = recording.recordingId;
      state.capture.startedAt = Date.now();
      state.phase = "recording";
      state.message = "Say “snap” to mark a moment, then “stop recording” to finish.";
      await save();
      void syncCapture().catch(problem);
    } catch (error) {
      // A start timeout can leave the camera running. Never silently start a
      // second recording or throw away the saved recovery journal.
      if (!cameraRequested) {
        state.capture = previous;
        state.phase = previous ? "complete" : "ready";
        if (previous) await save();
        else await session.storage.delete("capture");
      } else if (!state.capture?.recordingId) {
        state.message = "The glasses did not confirm that recording started. If their recording light is on, stop the recording with the glasses button before resetting here.";
      }
      throw error;
    }
  }

  async function snap() {
    const capture = state.capture;
    if (state.phase !== "recording" || !capture) return;
    if (capture.bookmarks.length >= 40) throw new Error("This session already has 40 marked moments.");
    const seconds = Math.max(0, (Date.now() - capture.startedAt) / 1000);
    if (seconds > 7190) throw new Error("Finish this recording before the two-hour limit.");
    capture.bookmarks.push({ id: crypto.randomUUID(), seconds, label: `Snap ${capture.bookmarks.length + 1}` });
    state.message = `Snap ${capture.bookmarks.length} marked. The still and clip will appear after upload.`;
    await save();
    publish();
    // No concurrent photo request. The Mac extracts the frame from the video.
    // Timing is approximate: this API has no word timestamps or recording clock.
    void session.speaker.speak("Moment marked").catch(() => {});
    void syncCapture().catch(problem);
  }

  async function stop() {
    const capture = state.capture;
    if (!capture?.recordingId || !["recording", "stopping"].includes(state.phase)) return;
    state.phase = "stopping";
    state.message = "Stopping the glasses and requesting the video upload…";
    publish();
    // A failed journal write must not prevent the camera from stopping.
    try { await save(); } catch (error) { problem(error); }
    await session.camera.stopVideoRecording(capture.recordingId, {
      uploadUrl: `${capture.server}/api/sessions/${capture.id}/video`,
    });
    state.phase = "waiting_upload";
    state.message = "Waiting for the glasses to upload. Keep the glasses, phone, and Mac on the same network.";
    await save();
  }

  async function poll() {
    const capture = state.capture;
    if (!capture || polling || state.busy || !["starting", "stopping", "waiting_upload", "processing", "awaiting_key"].includes(state.phase)) return;
    polling = true;
    try {
      const result = await api<{has_video: boolean; status: string; progress: string}>(`/api/sessions/${capture.id}`);
      if (result.has_video && ["starting", "stopping", "waiting_upload"].includes(state.phase)) {
        await syncCapture();
        await api(`/api/sessions/${capture.id}/process`, {}, "POST");
        state.phase = "processing";
        state.message = "Video received. Preparing the report on your Mac…";
      } else if (["complete", "awaiting_key"].includes(result.status)) {
        state.phase = result.status as "complete" | "awaiting_key";
        state.message = result.status === "complete" ? "Report ready on your Mac." : "Recording received. Add the OpenAI key on your Mac, restart the server, and retry processing.";
      } else if (result.status === "failed" || result.status === "interrupted") {
        state.message = result.progress;
        state.error = "Processing stopped. Open the Mac dashboard for details and retry.";
      } else if (state.phase === "processing") state.message = result.progress;
      await save();
      publish();
    } catch (error) { problem(error); }
    finally { polling = false; }
  }

  async function run(work: () => Promise<void>) {
    if (!hydrated || state.busy) return;
    state.busy = true;
    state.error = "";
    publish();
    try { await work(); } catch (error) { problem(error); }
    finally {
      state.busy = false; publish();
      if (stopQueued) {
        stopQueued = false;
        if (state.phase === "recording") void run(stop);
      }
    }
  }
  const dispatch = (command: Command) => {
    if (command === "stop" && state.busy) { stopQueued = true; return; }
    return run(() => command === "start" ? start() : command === "snap" ? snap() : stop());
  };

  let finishVoiceTimer: ReturnType<typeof setTimeout> | undefined;
  let commandVoiceTimer: ReturnType<typeof setTimeout> | undefined;
  let handledInterim: Command | null = null;
  function handleVoiceCommand(command: Command) {
    if (command === "start" && !["ready", "complete"].includes(state.phase)) {
      state.voice = state.phase === "starting" && !state.busy && !state.capture?.recordingId
        ? "Start heard. Reset the unconfirmed capture below before trying again."
        : "Start heard. Finish the current capture first.";
      publish();
      return;
    }
    if (!hydrated || state.busy && command !== "stop") {
      state.voice = "Command heard. Wait for the current action to finish.";
      publish();
      return;
    }
    if (command === lastCommand && Date.now() - lastCommandAt < 1800) return;
    lastCommand = command;
    lastCommandAt = Date.now();
    state.voice = `Voice command accepted: ${command}`;
    publish();
    void dispatch(command);
  }
  session.ui.handle("getState", () => ({ ...state }));
  session.ui.onOpen(publish);
  session.ui.on("command", ({command}) => { void dispatch(command); });
  session.ui.on("connect", ({server}) => { void run(async () => {
    if (state.capture && state.phase !== "complete") throw new Error("Finish the current session before changing the Mac address.");
    state.server = serverOrigin(server);
    await session.storage.set("server", state.server);
    const health = await api<{ai_configured: boolean}>("/api/health");
    state.aiConfigured = health.ai_configured;
    state.message = "Mac connected. Say “start recording” or tap Start.";
  }); });
  session.ui.on("retry", () => { void run(async () => {
    if (state.phase === "stopping") await stop();
    else if (state.capture) {
      await syncCapture();
      const current = await api<{has_video: boolean}>(`/api/sessions/${state.capture.id}`);
      if (current.has_video) {
        await api(`/api/sessions/${state.capture.id}/process`, {}, "POST");
        state.phase = "processing";
        state.message = "Retrying report processing…";
        await save();
      } else state.message = "No video has arrived. Check glasses Wi-Fi, or import their saved recording into this session on the Mac.";
    }
  }); });
  session.ui.on("wifi", () => { void run(() => session.glasses.requestWifiSetup("Inbound uploads recordings directly to your Mac over Wi-Fi.")); });
  session.ui.on("resetUnconfirmedStart", () => { void run(async () => {
    if (state.phase !== "starting" || state.capture?.recordingId) return;
    await session.storage.delete("capture");
    state.capture = null;
    state.phase = "ready";
    state.message = "Ready. Say “start” to record.";
  }); });
  session.ui.on("report", () => {
    const base = state.capture?.server || state.server;
    if (base) session.system.openUrl(base + (state.capture ? `/#${state.capture.id}` : "/"));
  });
  session.glasses.onConnection((data) => { state.connected = data.connected; state.camera = !!session.capabilities?.hasCamera; publish(); });
  session.glasses.onBattery((data) => { state.battery = data.level; publish(); });
  session.glasses.onWifi((data) => { state.wifi = data.connected; publish(); });
  session.on("ready", () => { state.camera = !!session.capabilities?.hasCamera; publish(); });
  session.transcription.onModelStatus((model) => {
    state.voice = model.state === "ready" ? "Voice commands ready" : model.state === "downloading" ? `Downloading voice model · ${Math.round(model.progress || 0)}%` : model.reason || `Voice model ${model.state}`;
    publish();
  });
  session.transcription.on((data) => {
    clearTimeout(finishVoiceTimer);
    clearTimeout(commandVoiceTimer);
    state.heard = data.text.slice(0, 180);
    publish();
    const command = commandFrom(data.text);
    if (!data.isFinal) {
      if (command) {
        finishVoiceTimer = setTimeout(() => {
          void session.transcription.finishUtterance().catch(() => {});
        }, 650);
        // Fixed-chunk models can leave short commands in the interim stream.
        // Use an exact, unchanged phrase after a pause and suppress its final echo.
        if (handledInterim !== command) {
          commandVoiceTimer = setTimeout(() => {
            handledInterim = command;
            handleVoiceCommand(command);
          }, 1400);
        }
      }
      return;
    }
    const duplicate = command === handledInterim;
    handledInterim = null;
    if (command && !duplicate) handleVoiceCommand(command);
  }, { processing: "localOnly" });

  try {
    state.server = await session.storage.get("server") || INBOUND_SERVER;
    const journal = await session.storage.get("capture");
    if (journal) {
      state.capture = JSON.parse(journal) as Capture;
      state.phase = state.capture.phase;
      state.message = "Recovered the previous session. Check the glasses before continuing.";
    }
  } catch (error) { problem(error); }
  hydrated = true;
  publish();
  setInterval(() => { void poll(); }, 4000);
});
