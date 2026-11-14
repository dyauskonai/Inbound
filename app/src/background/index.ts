import { MiniappErrorCode, MiniappRequestType, registerMiniapp } from "@mentra/miniapp/background";
import type { Capture, Channels, Command, Phase, State } from "../shared/channels";
import { canStartCapture, commandFrom, normalizeSpeech, serverOrigin } from "../shared/commands";

declare const INBOUND_SERVER: string;

// The previous build inherited the glasses' camera settings. Use a known
// capture profile while diagnosing missing Start acknowledgments.
const recordingOptions = { width: 1280, height: 720, fps: 30, save: true, sound: false };
const checkRecordingLight = "If the recording light is on, press the glasses’ action button once to stop and save the clip.";
const awaitingVideo: Phase[] = ["starting", "start_unconfirmed", "stopping", "waiting_upload"];
const rejectedStarts = new Set<string>([
  MiniappErrorCode.PERMISSION_NOT_DECLARED, MiniappErrorCode.NOT_IMPLEMENTED,
  "GLASSES_NOT_CONNECTED", "ALREADY_RECORDING", "already_recording", "battery_low", "service_unavailable", "missing_request_id",
]);

registerMiniapp<Channels>(async (session) => {
  const state: State = {
    phase: "ready", server: INBOUND_SERVER, defaultServer: INBOUND_SERVER, online: false, aiConfigured: false,
    captureMode: "live", streamUpdateRequired: false,
    camera: false, connected: false, wifi: false, battery: null,
    voice: "Waiting for the on-device English speech model", voiceCommand: "", heard: "", heardFinal: false,
    message: "Say “start recording” or connect to the Mac below.", error: "", capture: null, busy: false, stopPending: false, diagnostics: [],
  };
  let polling = false;
  let hydrated = false;
  let queuedStop: "voice" | "button" | null = null;
  let stopWarning: ReturnType<typeof setTimeout> | undefined;
  let publisherStop: Promise<void> | null = null;
  let pendingSpeech = "";
  let commandCandidateSeen = false;
  let speechActive = false;
  let silentSince = 0;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let utterance = 0;
  let finishingUtterance = -1;
  let finishSupported = true;
  let lastFallback: { command: Command; at: number } | null = null;
  let glassesModel: string | undefined;
  let lastUploadStatus = "";
  let pendingSnapTimes: number[] = [];
  let captureSync = Promise.resolve();
  let journalWrite = Promise.resolve();
  const snapshot = () => ({ ...state, diagnostics: [...state.diagnostics] });
  const publish = () => session.ui.send("state", snapshot());
  function diagnostic(event: string, fields: Record<string, string | number | boolean | undefined> = {}) {
    const detail = JSON.stringify({ phase: state.phase, ...fields });
    const entry = `${new Date().toISOString()} ${event} ${detail}`;
    state.diagnostics.push(entry);
    if (state.diagnostics.length > 80) state.diagnostics.shift();
    console.info(`[Inbound glasses] ${entry}`);
  }
  diagnostic("app.loaded", { sdk: "3.4.0", directCapture: true, width: recordingOptions.width, height: recordingOptions.height, fps: recordingOptions.fps });
  function save() {
    const capture = state.capture;
    if (!capture) return journalWrite;
    capture.phase = state.phase;
    const snapshot = JSON.stringify(capture);
    const written = journalWrite.then(() => session.storage.set("capture", snapshot));
    journalWrite = written.catch(() => {});
    return written;
  }
  const problem = (error: unknown, stage = "capture") => {
    state.error = error instanceof Error ? error.message : String((error as {message?: string})?.message || error);
    diagnostic("operation.failed", { stage, code: (error as {code?: string})?.code, error: state.error.replace(/(?:https?|rtmp):\/\/\S+/g, "[server address]").slice(0, 180) });
    publish();
  };

  function needsStreamingUpdate(error: unknown) {
    const issue = error as { code?: string; message?: string } | null;
    const code = issue?.code ?? "";
    const message = issue?.message ?? "";
    return /(?:update|upgrade)[_ -]required|firmware[_ -](?:too[_ -]old|unsupported)|outdated[_ -]firmware/i.test(code)
      || (/\b(?:updat(?:e|ed|ing)|upgrad(?:e|ed|ing)|outdated)\b/i.test(message)
        && /\b(?:glasses|firmware|software|stream(?:ing)?)\b/i.test(message));
  }

  function setCaptureMode(mode: State["captureMode"]) {
    state.captureMode = mode;
    return session.storage.set("captureMode", mode);
  }

  async function api<T>(path: string, body?: unknown, method = "GET", base = state.server): Promise<T> {
    if (!base) throw new Error("Enter the Mac server address first.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkingUpload = method === "GET" && path.startsWith("/api/sessions/");
    if (!checkingUpload) diagnostic("mac.request", { method, path });
    try {
      const request = fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // Mentra's background fetch doesn't honor AbortSignal. For capture metadata,
      // wait for the native request to settle so successive writes stay ordered.
      const response = method === "PUT" ? await request : await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The Mac server did not respond. Check the address and Wi-Fi.")), 12000);
        }),
      ]);
      state.online = true;
      if (!checkingUpload || !response.ok) diagnostic("mac.response", { method, path, status: response.status });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.detail === "string" ? data.detail : `Mac server returned ${response.status}`);
      if (data === null) throw new Error("The Mac address did not return an Inbound response.");
      return data as T;
    } catch (error) {
      state.online = false;
      if (!checkingUpload) diagnostic("mac.request_failed", { method, path });
      throw error;
    }
    finally { clearTimeout(timer); }
  }

  function syncCapture(capture: Capture) {
    const synced = captureSync.then(async () => {
      await api(`/api/sessions/${capture.id}/capture`, {
        bookmarks: capture.bookmarks,
        started_at: new Date(capture.startedAt).toISOString(),
      }, "PUT", capture.server);
    });
    captureSync = synced.catch(() => {});
    return synced;
  }

  function syncWhileRecording(capture: Capture) {
    void syncCapture(capture).catch((error) => {
      if (state.capture === capture && state.phase === "recording") problem(error);
    });
  }

  async function start() {
    if (!session.capabilities?.hasCamera) throw new Error("Connect Mentra Live glasses in the Mentra app first.");
    if (publisherStop) throw new Error("Wait for the glasses to finish stopping before starting another capture.");
    const previous = state.capture;
    const previousPhase = state.phase;
    state.capture = null;
    pendingSnapTimes = [];
    lastUploadStatus = "";
    state.phase = "starting";
    state.message = "Connecting to the Mac to save this recording…";
    publish();
    let journalRequested = false;
    let cameraRequestedAt: number | undefined;
    const restorePreviousCapture = async () => {
      state.capture = previous;
      state.phase = previousPhase;
      if (!journalRequested) return;
      if (previous) await save().catch(problem);
      else await session.storage.delete("capture").catch(problem);
    };
    try {
      if (state.server !== INBOUND_SERVER && INBOUND_SERVER && /^http:\/\/\d+(\.\d+){3}:8000$/.test(state.server)) {
        try {
          const health = await api<{ok: boolean}>("/api/health");
          if (health.ok !== true) throw new Error("The saved address is not an Inbound server.");
        } catch (savedAddressError) {
          const health = await api<{ok: boolean}>("/api/health", undefined, "GET", INBOUND_SERVER);
          if (health.ok !== true) throw savedAddressError;
          diagnostic("mac.using_current_address");
          state.server = INBOUND_SERVER;
          void session.storage.set("server", state.server).catch(problem);
        }
      }
      const result = await api<{id: string; live_capture?: boolean}>("/api/sessions", {
        title: `Glasses recording · ${new Date().toLocaleTimeString()}`, source: "glasses",
      }, "POST");
      if (!result.id) throw new Error("The Mac address did not return an Inbound session.");
      state.capture = { id: result.id, startedAt: Date.now(), bookmarks: [], phase: "starting", server: state.server };
      journalRequested = true;
      diagnostic("capture.journal_writing", { session: result.id });
      await save();
      if (queuedStop) {
        diagnostic("camera.start_cancelled", { session: result.id });
        await restorePreviousCapture();
        state.message = "Start cancelled before the camera was turned on.";
        return;
      }
      const capture = state.capture;
      if (result.live_capture && state.captureMode === "live") {
        if (!await startLive(capture)) {
          await restorePreviousCapture();
          state.message = "Start cancelled before the camera was turned on.";
        }
        return;
      }
      cameraRequestedAt = Date.now();
      diagnostic("camera.start_requested", { session: capture.id, connected: state.connected, wifi: state.wifi, ...recordingOptions });
      state.message = "Starting the glasses camera…";
      publish();
      const recording = await session.camera.startVideoRecording(recordingOptions);
      if (!recording?.recordingId) throw new Error("The glasses did not return a recording ID.");
      capture.recordingId = recording.recordingId;
      capture.startedAt = Date.now();
      state.phase = "recording";
      diagnostic("camera.started", { session: capture.id, recording: recording.recordingId, elapsedMs: Date.now() - cameraRequestedAt });
      state.message = "Say “snap” to mark a moment, then “stop recording” to finish.";
      void save().catch(problem);
      syncWhileRecording(capture);
    } catch (error) {
      // A start timeout can leave the camera running. Never silently start a
      // second recording or throw away the saved recovery journal.
      const code = (error as {code?: string})?.code;
      if (cameraRequestedAt === undefined || (code && rejectedStarts.has(code))) {
        await restorePreviousCapture();
        state.message = "Could not start the recording. Check the error below and try again.";
      } else if (!state.capture?.recordingId) {
        state.phase = "start_unconfirmed";
        diagnostic("camera.start_unconfirmed", { session: state.capture?.id, code, elapsedMs: Date.now() - cameraRequestedAt, stopRequested: state.stopPending });
        state.message = `Mentra did not confirm Start. ${checkRecordingLight} You can attach the saved clip on the Mac.`;
        void save().catch(problem);
      }
      throw error;
    }
  }

  async function startLive(capture: Capture): Promise<boolean> {
    const remote = /^https?:\/\/([a-z0-9.-]+)(?::\d+)?$/i.exec(capture.server);
    if (!remote) throw new Error("Direct glasses capture needs the Mac’s local network address.");
    const path = `/api/sessions/${capture.id}/live`;
    const receiver = await api<{port: number; key: string}>(`${path}/start`, {}, "POST", capture.server);
    capture.live = true;
    void save().catch(problem);
    if (queuedStop) {
      await api(`${path}/stop`, {}, "POST", capture.server);
      return false;
    }
    state.message = "Starting the glasses camera. Waiting for video on your Mac…";
    diagnostic("live.start_requested", { session: capture.id, port: receiver.port });
    publish();
    void session.stream.startStream({
      direct: `rtmp://${remote[1]}:${receiver.port}/live/${receiver.key}`,
      video: { width: 1280, height: 720, fps: 30, bitrate: 2000000 }, sound: false, captureAudio: true,
    }).then((result) => {
      if (state.capture !== capture || !result?.streamId) return;
      capture.streamId = result.streamId;
      diagnostic("live.publisher_acknowledged", { session: capture.id, stream: capture.streamId });
      void save().catch(problem);
      publish();
    }).catch((error) => {
      if (state.capture !== capture || state.phase !== "starting") return;
      if (!needsStreamingUpdate(error)) {
        problem(error, "glasses stream start");
        return;
      }
      void run(async () => {
        diagnostic("live.update_required", { session: capture.id, code: (error as {code?: string})?.code });
        const result = await api<{has_video: boolean}>(`${path}/stop`, {}, "POST", capture.server);
        if (result.has_video) {
          state.phase = "waiting_upload";
          state.message = "Video arrived before Mentra reported the update requirement. Preparing the saved clip.";
          await save();
          return;
        }
        await journalWrite;
        state.capture = null;
        state.phase = "ready";
        state.streamUpdateRequired = true;
        state.message = "Mentra requires a glasses update for live video. On-glasses recording is selected for your next attempt.";
        state.voiceCommand = "";
        await setCaptureMode("device");
        await session.storage.delete("capture");
      });
    });
    return true;
  }

  function snap(at = Date.now()) {
    const capture = state.capture;
    if (!capture) return;
    if (capture.bookmarks.length >= 40) throw new Error("This session already has 40 marked moments.");
    const seconds = Math.max(0, (at - capture.startedAt) / 1000);
    if (seconds > 7190) throw new Error("Finish this recording before the two-hour limit.");
    const number = capture.bookmarks.length + 1;
    capture.bookmarks.push({ id: `mark-${number}`, seconds, label: `Snap ${number}` });
    diagnostic("snap.marked", { session: capture.id, number, seconds: Math.round(seconds * 100) / 100 });
    state.message = `Snap ${number} marked. The still and clip will appear after upload.`;
    publish();
    syncWhileRecording(capture);
    void save().catch(problem);
  }

  async function stop() {
    const capture = state.capture;
    if (capture?.live) {
      await stopLive(capture);
      return;
    }
    if (!capture?.recordingId || !["recording", "stopping"].includes(state.phase)) return;
    state.phase = "stopping";
    const requestedAt = Date.now();
    diagnostic("camera.stop_requested", { session: capture.id, recording: capture.recordingId, wifi: state.wifi });
    state.message = "Stopping the glasses and requesting the video upload…";
    publish();
    stopWarning = setTimeout(() => {
      state.message = `Waiting for Mentra to confirm Stop and upload. ${checkRecordingLight}`;
      diagnostic("camera.stop_still_waiting", { session: capture.id });
      publish();
    }, 5000);
    // A stalled journal write must not hold up the camera stop request.
    void save().catch(problem);
    try {
      await session.camera.stopVideoRecording(capture.recordingId, {
        uploadUrl: `${capture.server}/api/sessions/${capture.id}/video`,
      });
    } catch (error) {
      const code = (error as {code?: string})?.code;
      if (code !== "RECORDING_NOT_OWNED" && code !== "media_error") {
        state.message = `Mentra did not confirm Stop. You can retry Stop. ${checkRecordingLight}`;
        throw error;
      }
      state.phase = code === "RECORDING_NOT_OWNED" ? "stopping" : "waiting_upload";
      state.message = code === "media_error"
        ? "The glasses reported an upload error. Look for the saved recording in Mentra’s gallery and attach it on the Mac."
        : `Mentra lost control of this recording. ${checkRecordingLight} If the clip is already saved, attach it on the Mac.`;
      void save().catch(problem);
      throw error;
    } finally {
      clearTimeout(stopWarning);
    }
    state.phase = "waiting_upload";
    diagnostic("camera.stop_acknowledged", { session: capture.id, elapsedMs: Date.now() - requestedAt });
    state.message = "Waiting for the glasses to upload. Keep the glasses, phone, and Mac on the same network.";
    void save().catch(problem);
  }

  async function stopLive(capture: Capture) {
    state.phase = "stopping";
    state.message = "Stopping the glasses and saving the video on your Mac…";
    diagnostic("live.stop_requested", { session: capture.id, stream: capture.streamId });
    void save().catch(problem);
    publish();
    // Without an ID the Mentra API stops this MiniApp's stream. The Mac can
    // close and save the file even if the glasses' reply is delayed.
    stopPublisher(capture);
    const result = await api<{has_video: boolean; live_started_at?: number}>(`/api/sessions/${capture.id}/live/stop`, {}, "POST", capture.server);
    if (result.has_video && result.live_started_at) {
      capture.startedAt = result.live_started_at;
      for (const at of pendingSnapTimes) snap(at);
      pendingSnapTimes = [];
    }
    state.phase = result.has_video ? "waiting_upload" : "start_unconfirmed";
    state.message = result.has_video
      ? "Recording saved on the Mac. Preparing the video and snaps. If the camera light stays on, retry Stop glasses."
      : "No video reached the Mac. Check the glasses’ Wi-Fi connection and try again when the camera is idle.";
    diagnostic("live.mac_finalized", { session: capture.id, video: result.has_video });
    await save();
  }

  function stopPublisher(capture: Capture) {
    if (publisherStop) return;
    publisherStop = session.stream.stop(capture.streamId).then(() => {
      if (state.capture !== capture) return;
      diagnostic("live.publisher_stopped", { session: capture.id });
      publish();
    }).catch((error) => {
      if (state.capture === capture) problem(error, "glasses stream stop");
    }).finally(() => { publisherStop = null; });
  }

  async function poll() {
    const capture = state.capture;
    if (!capture || polling || state.busy || ![...awaitingVideo, "processing", "awaiting_key", ...(capture.live ? ["recording"] : [])].includes(state.phase)) return;
    polling = true;
    try {
      const result = await api<{has_video: boolean; status: string; progress: string; live_state?: string; live_started_at?: number; error?: string}>(`/api/sessions/${capture.id}`, undefined, "GET", capture.server);
      if (state.capture !== capture || state.busy) return;
      if (capture.live && state.phase === "starting") {
        if (result.live_state === "recording" && result.live_started_at) {
          capture.startedAt = result.live_started_at;
          state.phase = "recording";
          state.error = "";
          state.message = "Video is reaching the Mac. Say “snap” or “stop”.";
          diagnostic("live.mac_recording", { session: capture.id });
          void save().catch(problem);
          for (const at of pendingSnapTimes) snap(at);
          pendingSnapTimes = [];
        } else if (result.live_state === "failed") {
          state.phase = "start_unconfirmed";
          state.message = "No video reached the Mac. Check glasses Wi-Fi and allow incoming video on the Mac.";
          state.error = result.error || "Live capture failed.";
          diagnostic("live.receiver_failed", { session: capture.id });
          stopPublisher(capture);
          void save().catch(problem);
        }
      }
      if (capture.live && (state.phase === "recording" || state.phase === "starting") && result.has_video) {
        if (result.live_started_at) {
          capture.startedAt = result.live_started_at;
          for (const at of pendingSnapTimes) snap(at);
          pendingSnapTimes = [];
        }
        state.phase = "waiting_upload";
        diagnostic("live.publisher_ended", { session: capture.id });
        stopPublisher(capture);
      } else if (capture.live && state.phase === "recording" && result.live_state === "failed") {
        state.phase = "start_unconfirmed";
        state.message = "The Mac could not finish saving this clip. Stop the glasses, then check the capture log.";
        state.error = result.error || "Live capture failed.";
        stopPublisher(capture);
        void save().catch(problem);
      }
      if (result.status !== lastUploadStatus) {
        lastUploadStatus = result.status;
        diagnostic("mac.capture_status", { session: capture.id, status: result.status, video: result.has_video });
      }
      if (result.status === "uploaded" && result.has_video && awaitingVideo.includes(state.phase)) {
        await run(async () => {
          await syncCapture(capture);
          await api(`/api/sessions/${capture.id}/process`, {}, "POST", capture.server);
          state.phase = "processing";
          state.message = "Video received. Preparing the report on your Mac…";
          await save();
        });
      } else if (result.status === "complete" || result.status === "awaiting_key" || result.status === "processing") {
        if (state.phase !== result.status) {
          state.phase = result.status;
          state.error = "";
          void save().catch(problem);
        }
        state.message = result.status === "complete" ? "Report ready on your Mac."
          : result.status === "awaiting_key" ? "Recording and snaps ready. Add the OpenAI key on your Mac to generate the report."
          : result.progress;
      } else if (result.status === "failed" || result.status === "interrupted") {
        state.message = result.progress;
        state.error = "Processing stopped. Open the Mac dashboard for details and retry.";
      }
      publish();
    } catch (error) {
      if (state.capture === capture && !state.busy && state.error !== (error as {message?: string})?.message) problem(error, "upload check");
    }
    finally { polling = false; }
  }

  async function run(work: () => void | Promise<void>) {
    if (!hydrated || state.busy) return;
    state.busy = true;
    state.error = "";
    publish();
    try { await work(); } catch (error) { problem(error); }
    finally {
      state.busy = false;
      const stopSource = queuedStop;
      queuedStop = null;
      state.stopPending = false;
      if (stopSource) {
        if (state.phase === "recording" || (state.capture?.live && state.phase === "starting")) {
          diagnostic("command.queue_dispatched", { command: "stop", source: stopSource });
          if (stopSource === "voice") state.voiceCommand = "Voice command accepted: stop";
          void run(stop);
        } else {
          const unconfirmed = state.phase === "start_unconfirmed";
          diagnostic(unconfirmed ? "command.queue_blocked" : "command.queue_cleared", {
            command: "stop", source: stopSource, reason: unconfirmed ? "missing_recording_id" : "start_did_not_complete",
          });
          state.voiceCommand = unconfirmed ? "Stop could not be sent. Mentra did not provide a recording ID." : "Start ended before the glasses confirmed a recording.";
        }
      }
      publish();
    }
  }
  function dispatch(command: Command, source: "voice" | "button" = "button") {
    const voice = source === "voice";
    diagnostic("command.received", { command, source });
    const feedback = (message: string) => {
      if (voice) state.voiceCommand = message;
      publish();
    };
    const ignore = (reason: string, message: string) => {
      diagnostic("command.ignored", { command, source, reason });
      feedback(message);
    };
    if (command === "stop" && state.busy && (state.phase === "starting" || state.phase === "recording")) {
      if (!queuedStop || voice) queuedStop = source;
      state.stopPending = true;
      diagnostic("command.queued", { command, source });
      state.voiceCommand = state.capture?.live ? "Stop requested. Closing the Mac’s video receiver." : `Stop requested. Waiting for Mentra to confirm Start. ${checkRecordingLight}`;
      publish();
      return;
    }
    if (command === "stop" && state.capture?.live && ["processing", "awaiting_key", "complete"].includes(state.phase)) {
      stopPublisher(state.capture);
      return feedback("Stop sent to the glasses. Your video is already on the Mac.");
    }
    if (!hydrated || state.busy) return ignore("busy", `Heard “${command}”. Wait for the current action to finish.`);
    if (command === "start" && state.phase === "waiting_upload" && state.capture?.live) {
      diagnostic("command.accepted", { command, source });
      feedback("Voice command accepted: start");
      return run(async () => {
        const current = state.capture;
        if (!current) return;
        const saved = await api<{has_video: boolean}>(`/api/sessions/${current.id}`, undefined, "GET", current.server);
        if (!saved.has_video) throw new Error("The previous recording is still being saved. Try Start again after it finishes.");
        await syncCapture(current);
        await api(`/api/sessions/${current.id}/process`, {}, "POST", current.server);
        await start();
      });
    }
    if (command === "start" && !canStartCapture(state.phase)) {
      const message = state.phase === "start_unconfirmed"
        ? "Heard “start”. Check the recording light before trying again."
        : state.phase === "waiting_upload"
          ? "Heard “start”. Tap Start a new capture once the recording light is off."
          : "Heard “start”. Finish the current capture first.";
      return ignore("capture_in_progress", message);
    }
    if (command === "snap" && state.phase === "starting" && state.capture?.live) {
      if (pendingSnapTimes.length >= 40) return ignore("snap_limit", "This recording already has 40 requested snaps.");
      pendingSnapTimes.push(Date.now());
      diagnostic("snap.waiting_for_video", { session: state.capture.id });
      return feedback("Snap requested. Waiting for the first video from the glasses.");
    }
    if (command === "snap" && state.phase !== "recording") return ignore("no_recording", "Heard “snap”. Start a recording first.");
    if (command === "stop" && !state.capture?.recordingId && !state.capture?.live) {
      return ignore("missing_recording_id", state.phase === "start_unconfirmed"
        ? `Stop could not be sent. ${checkRecordingLight}`
        : "Heard “stop”. Start a recording first.");
    }
    if (command === "stop" && state.phase !== "recording" && state.phase !== "stopping" &&
        !(state.capture?.live && ["starting", "start_unconfirmed", "waiting_upload"].includes(state.phase))) {
      return ignore("recording_ended", "Heard “stop”. This recording has already ended.");
    }
    diagnostic("command.accepted", { command, source });
    feedback(`Voice command accepted: ${command}`);
    return run(() => command === "start" ? start() : command === "snap" ? snap() : stop());
  }
  session.ui.handle("getState", snapshot);
  session.ui.handle("copyDiagnostics", () => session.system.copyToClipboard(state.diagnostics.join("\n")));
  session.ui.onOpen(publish);
  session.ui.on("command", ({command}) => { void dispatch(command); });
  session.ui.on("captureMode", ({mode}) => { void run(async () => {
    if (!canStartCapture(state.phase) || !["live", "device"].includes(mode)) return;
    state.streamUpdateRequired = false;
    state.message = mode === "live" ? "Ready to send video directly to the Mac." : "Ready to record on the glasses and upload after Stop.";
    await setCaptureMode(mode);
  }); });
  session.ui.on("connect", ({server}) => { void run(async () => {
    if (state.capture && !canStartCapture(state.phase)) throw new Error("Finish the current session before changing the Mac address.");
    const address = serverOrigin(server);
    const health = await api<{ok: boolean; ai_configured: boolean}>("/api/health", undefined, "GET", address);
    if (health.ok !== true) throw new Error("The Mac address did not return an Inbound health check.");
    state.server = address;
    await session.storage.set("server", address);
    state.aiConfigured = health.ai_configured;
    state.message = "Mac connected. Say “start recording” or tap Start.";
  }); });
  session.ui.on("retry", () => { void run(async () => {
    if (state.phase === "stopping" && state.capture) {
      const capture = state.capture;
      // An upload can succeed after the host's stop request has timed out.
      // Check the Mac before sending a second stop for the same recording.
      const current = await api<{has_video: boolean}>(`/api/sessions/${capture.id}`, undefined, "GET", capture.server).catch(() => null);
      if (current?.has_video) {
        state.phase = "waiting_upload";
        state.message = "Video received. Preparing the report on your Mac…";
        await save();
      } else await stop();
    } else if (state.capture && ["waiting_upload", "processing", "awaiting_key"].includes(state.phase)) {
      const capture = state.capture;
      const current = await api<{has_video: boolean}>(`/api/sessions/${capture.id}`, undefined, "GET", capture.server);
      diagnostic("mac.upload_checked", { session: capture.id, video: current.has_video });
      if (current.has_video) {
        await syncCapture(capture);
        await api(`/api/sessions/${capture.id}/process`, {}, "POST", capture.server);
        state.phase = "processing";
        state.message = "Retrying report processing…";
        await save();
      } else state.message = "No video has arrived. Check glasses Wi-Fi, or import their saved recording into this session on the Mac.";
    }
  }); });
  session.ui.on("wifi", () => { void run(() => session.glasses.requestWifiSetup("Inbound uploads recordings directly to your Mac over Wi-Fi.")); });
  session.ui.on("resetUnconfirmedStart", () => { void run(async () => {
    if (state.phase !== "start_unconfirmed") return;
    await journalWrite;
    await session.storage.delete("capture");
    state.capture = null;
    state.phase = "ready";
    state.message = "Ready. Say “start” to record.";
    state.voiceCommand = "";
    diagnostic("camera.unconfirmed_reset");
  }); });
  session.ui.on("confirmStoppedOnGlasses", () => { void run(async () => {
    if (state.phase !== "start_unconfirmed" && state.phase !== "stopping") return;
    state.phase = "waiting_upload";
    state.voiceCommand = "";
    state.message = "Open Camera in Mentra and sync the clip. Export it, then choose Attach recording on this session in the Mac dashboard.";
    diagnostic("camera.stopped_on_glasses", { session: state.capture?.id });
    await save();
  }); });
  session.ui.on("newCapture", () => { void run(async () => {
    if (state.phase !== "waiting_upload") return;
    if (publisherStop) throw new Error("Wait for the glasses to finish stopping before starting another capture.");
    await journalWrite;
    await session.storage.delete("capture");
    diagnostic("capture.resumed_in_new_session", { previous: state.capture?.id });
    state.capture = null;
    state.phase = "ready";
    state.message = "Ready for a new capture. You can still attach the previous clip on the Mac.";
    state.voiceCommand = "";
  }); });
  session.ui.on("stopPublisher", () => {
    if (state.capture?.live) stopPublisher(state.capture);
  });
  session.ui.on("report", () => {
    const base = state.capture?.server || state.server;
    if (base) session.system.openUrl(base + (state.capture ? `/#${state.capture.id}` : "/"));
  });
  session.glasses.onConnection((data) => {
    const changed = state.connected !== data.connected || glassesModel !== data.modelName;
    state.connected = data.connected;
    glassesModel = data.modelName;
    if (changed) diagnostic("glasses.connection", { connected: data.connected, model: data.modelName });
    if (!data.connected) resetSpeech();
    publish();
  });
  session.glasses.onBattery((data) => { state.battery = data.level; publish(); });
  session.glasses.onWifi((data) => {
    if (state.wifi !== data.connected) diagnostic("glasses.wifi", { connected: data.connected });
    state.wifi = data.connected;
    publish();
  });
  session.on("ready", () => {
    state.camera = !!session.capabilities?.hasCamera;
    diagnostic("mentra.ready", { camera: state.camera });
    publish();
    // Leave the phone's speech detector subscribed and keep the actual mic
    // stream continuous so the on-device recognizer sees the trailing silence.
    for (const [gate, request] of [
      ["loudness", () => session.mic.setLoudnessGateEnabled(false)],
      ["glasses_vad", () => session.mic.setVoiceActivityDetectionEnabled(false)],
    ] as const) {
      void request().then(() => diagnostic("speech.mic_gate_off", { gate })).catch((error: {code?: string}) => {
        diagnostic("speech.mic_gate_unavailable", { gate, code: error?.code });
      }).finally(publish);
    }
  });
  session.on("capabilities", (capabilities) => { state.camera = !!capabilities?.hasCamera; publish(); });
  session.permissions.onPermissionError((error) => {
    if (error.permission?.toLowerCase() !== "microphone") return;
    state.voice = "Mentra did not grant Inbound microphone access.";
    diagnostic("speech.permission_error", { code: error.code });
    publish();
  });
  session.transcription.onModelStatus((model) => {
    if (model.state !== "ready") resetSpeech();
    if (model.language && model.language !== "en-US") {
      state.voice = "Select English for speech recognition in Mentra’s Speech settings.";
    } else if (model.state === "ready") state.voice = "Voice commands ready";
    else if (model.state === "downloading") state.voice = `Downloading English speech model · ${Math.round(model.progress || 0)}%`;
    else state.voice = model.reason || `English speech model ${model.state}`;
    diagnostic("speech.model", { state: model.state, language: model.language });
    publish();
  });

  function resetSpeech() {
    clearTimeout(finishTimer);
    finishTimer = undefined;
    pendingSpeech = "";
    commandCandidateSeen = false;
    speechActive = false;
    silentSince = 0;
    utterance++;
  }

  function receiveFinal(text: string) {
    const phrase = normalizeSpeech(text);
    const command = commandFrom(text);
    const duplicate = lastFallback !== null && command === lastFallback.command && Date.now() - lastFallback.at < 1600;
    lastFallback = null;
    resetSpeech();
    state.heard = text.slice(0, 180);
    state.heardFinal = true;
    diagnostic("speech.final", { command: command ?? "none", words: phrase ? phrase.split(" ").length : 0 });
    if (duplicate) diagnostic("speech.final_echo", { command: command ?? undefined });
    else if (command) {
      void dispatch(command, "voice");
      return;
    } else state.voiceCommand = "Say a command on its own, such as “start recording”.";
    publish();
  }

  function finishAfterPause() {
    clearTimeout(finishTimer);
    finishTimer = undefined;
    if (!pendingSpeech || !commandCandidateSeen || finishingUtterance === utterance) return;
    const currentUtterance = utterance;
    const delay = silentSince ? Math.max(0, 750 - (Date.now() - silentSince)) : 1400;
    // Mentra may stop sending interim updates without emitting a silence or
    // final event. Always ask it to settle the latest text after a pause.
    finishTimer = setTimeout(() => {
      finishTimer = undefined;
      const phrase = pendingSpeech;
      const endpoint = silentSince ? "silence" : "transcript_pause";
      finishingUtterance = currentUtterance;
      diagnostic("speech.finish_requested", { command: commandFrom(phrase) ?? "none", endpoint, speechActive });
      publish();
      const finish = (finalText: string | null) => {
        if (currentUtterance !== utterance) return; // A final event or newer speech already arrived.
        diagnostic("speech.finish_result", { result: finalText === null ? "unavailable" : finalText ? "text" : "empty" });
        if (finalText) {
          receiveFinal(finalText);
          return;
        }
        const command = commandFrom(phrase);
        resetSpeech();
        // A quiet transcript can be a missing endpoint. Active audio without
        // a silence event can also be a deliberate pause mid-sentence.
        if (command && (!speechActive || silentSince)) {
          lastFallback = { command, at: Date.now() };
          diagnostic("speech.command_after_pause", { command, endpoint });
          void dispatch(command, "voice");
        } else {
          diagnostic("speech.command_unresolved", { command: command ?? "none", endpoint, speechActive });
          state.voiceCommand = "Say a command on its own, such as “start recording”.";
          publish();
        }
      };
      if (!finishSupported) {
        finish(null);
        return;
      }
      // Native finishing can take three seconds. Cap the bridge wait for
      // older hosts that accept the message but never answer it.
      void session.sendRequest<string | null>({ type: MiniappRequestType.TRANSCRIPTION_FINISH }, { timeoutMs: 4500 })
        .then(finish)
        .catch((error: {code?: string}) => {
          diagnostic("speech.finish_failed", { code: error?.code });
          if (error?.code === MiniappErrorCode.NOT_IMPLEMENTED) finishSupported = false;
          if (error?.code === MiniappErrorCode.NOT_IMPLEMENTED || error?.code === MiniappErrorCode.ACTION_TIMEOUT) finish(null);
          else {
            if (currentUtterance === utterance) resetSpeech();
            publish();
          }
        });
    }, delay);
  }

  session.transcription.forLanguage("en-US", (data) => {
    const phrase = normalizeSpeech(data.text);
    if (!phrase) return;
    if (state.voice === "Waiting for the on-device English speech model") state.voice = "Voice commands ready";
    const command = commandFrom(phrase);
    if (data.isFinal) {
      receiveFinal(data.text);
      return;
    }
    state.heard = data.text.slice(0, 180);
    state.heardFinal = false;
    // A changed hypothesis supersedes any outstanding request to finish it.
    // Repeated identical partials do not push back the timer.
    if (phrase !== pendingSpeech) {
      diagnostic("speech.transcript", { final: false, command: command ?? "none", source: data.source, words: phrase.split(" ").length });
      lastFallback = null;
      utterance++;
      pendingSpeech = phrase;
      commandCandidateSeen ||= command !== null;
      finishAfterPause();
    }
    publish();
  }, { processing: "localOnly" });
  session.mic.onVoiceActivity(({status, silentForMs}) => {
    if (status) {
      if (silentSince) resetSpeech();
      lastFallback = null;
      speechActive = true;
      diagnostic("speech.activity", { speaking: true });
      finishAfterPause();
      publish();
      return;
    }
    speechActive = false;
    silentSince = Date.now() - Math.max(0, silentForMs ?? 0);
    diagnostic("speech.activity", { speaking: false, silentForMs, command: commandFrom(pendingSpeech) ?? "none" });
    if (finishingUtterance === utterance) utterance++;
    finishAfterPause();
    publish();
  });

  try {
    state.server = await session.storage.get("server") || INBOUND_SERVER;
    if (await session.storage.get("captureMode") === "device") state.captureMode = "device";
    const journal = await session.storage.get("capture");
    if (journal) {
      state.capture = JSON.parse(journal) as Capture;
      state.phase = state.capture.phase === "starting" && !state.capture.recordingId && !state.capture.live ? "start_unconfirmed" : state.capture.phase;
      state.message = state.phase === "start_unconfirmed"
        ? `Start was unconfirmed in the previous session. ${checkRecordingLight}`
        : "Recovered the previous session. Check the glasses before continuing.";
    }
  } catch (error) { problem(error); }
  hydrated = true;
  diagnostic("capture.ready", { savedCapture: !!state.capture, addressChanged: state.server !== INBOUND_SERVER });
  publish();
  const pollTimer = setInterval(() => { void poll(); }, 1000);
  session.on("disconnect", () => { resetSpeech(); clearTimeout(stopWarning); clearInterval(pollTimer); });
});
