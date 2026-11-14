import { MiniappRequestType, registerMiniapp } from "@mentra/miniapp/background";
import type { Capture, CaptureVideo, Channels, Command, Photo, State } from "../shared/channels";
import { findCommands, isPhoneRelay, serverOrigin, speechWords } from "../shared/commands";

declare const INBOUND_SERVER: string;
declare const INBOUND_LOCAL_SERVER: string;
// Set when the build targets an internet server; that server refuses requests without it.
declare const INBOUND_TOKEN: string;

type MacHealth = { ok: boolean; ai_configured?: boolean };
type PhotoResult = { photoUrl?: string; key?: string; url?: string; mimeType?: string };
interface Job {
  capture: Capture;
  path: string;
  body: string | Uint8Array;
  contentType: string;
  label: string;
  bytes: number;
  tries: number;
  done?: (ok: boolean) => void;
}

// Everything reaches the Mac through the phone. Glasses-to-Mac Wi-Fi uploads
// never arrived on the demo network, so v1 sends mic audio, transcript lines,
// and photos as small idempotent requests that retry until the Mac has them.
const AUDIO_FLUSH_MS = 4000;
const AUDIO_FLUSH_CHARS = 256 * 1024;
const OUTBOX_LIMIT = 48 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
const PHOTO_TIMEOUT_MS = 30000;
// Re-warmed while a photo-only capture runs, and cools down within this long after Stop.
const WARM_MS = 60000;
const VIDEO_START_TIMEOUT_MS = 30000;
// `save` keeps a copy in the glasses' gallery in case the Wi-Fi upload fails.
const videoOptions = { width: 1280, height: 720, fps: 30, save: true, sound: false };
// A command word at the end of a partial transcript can still grow ("stop" → "stopped").
const SETTLE_MS = 350;
const REPEAT_MS = 1500;
const finished = new Set(["complete", "awaiting_key", "failed", "interrupted"]);

registerMiniapp<Channels>(async (session) => {
  const state: State = {
    phase: "ready", server: INBOUND_SERVER, defaultServer: INBOUND_SERVER,
    online: false, aiConfigured: false, camera: false, connected: false, wifi: false, glassesNetwork: "", videoEnabled: true, battery: null, audio: false,
    voice: "Waiting for the on-device English speech model", voiceCommand: "", heard: "", heardFinal: false,
    message: "Say “start” to begin. Nothing is recorded or sent until then.", error: "",
    capture: null, delivered: null, pending: 0, pendingBytes: 0, busy: false, diagnostics: [],
  };
  let hydrated = false;
  let closed = false;
  // Photos in flight. Stop sends finish only after all of them settle.
  const photoTasks = new Set<Promise<void>>();
  let lastPhoto: Promise<void> = Promise.resolve();
  let videoStarting: Promise<void> | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  let journalWrite = Promise.resolve();
  let audioChunks: string[] = [];
  let audioChars = 0;
  let audioAt = 0;
  let audioBatchStarted = 0;
  let audioRate = 16000;
  let audioFormat: string | undefined;
  let words: string[] = [];
  let fired = new Map<Command, number>();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastVoice: { command: Command; at: number } | null = null;
  let lastFinal = { text: "", at: 0 };
  let lastStatusCheck = 0;
  const sent = new WeakMap<Capture, number>();
  const outbox: Job[] = [];
  let pumping = false;

  const snapshot = () => ({ ...state, diagnostics: [...state.diagnostics] });
  const publish = () => session.ui.send("state", snapshot());
  const elapsed = (capture: Capture) => Math.max(0, Math.round((Date.now() - capture.startedAt) / 10) / 100);
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  function diagnostic(event: string, fields: Record<string, string | number | boolean | undefined> = {}) {
    const entry = `${new Date().toISOString()} ${event} ${JSON.stringify({ phase: state.phase, ...fields })}`;
    state.diagnostics.push(entry);
    if (state.diagnostics.length > 120) state.diagnostics.shift();
    console.info(`[Inbound glasses] ${entry}`);
  }
  diagnostic("app.loaded", { sdk: "3.4.0", transport: "phone" });
  const problem = (error: unknown, stage = "capture") => {
    state.error = error instanceof Error ? error.message : String((error as { message?: string })?.message || error);
    diagnostic("operation.failed", { stage, code: (error as { code?: string })?.code, error: state.error.replace(/https?:\/\/\S+/g, "[address]").slice(0, 180) });
    publish();
  };

  function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Mentra's background fetch doesn't honor AbortSignal, so race a deadline.
    return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
      .finally(() => clearTimeout(timer));
  }

  async function request<T>(base: string, path: string, method = "GET", body?: string | Uint8Array, contentType = "application/json", timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!base) throw new Error("Enter the Mac server address first.");
    try {
      const response = await withTimeout(fetch(base + path, {
        // Mentra's fetch sends typed-array bodies as binary.
        method, body: body as BodyInit | undefined, headers: {
          ...(body === undefined ? {} : { "Content-Type": contentType }),
          ...(INBOUND_TOKEN ? { Authorization: `Bearer ${INBOUND_TOKEN}` } : {}),
        },
      }), timeoutMs, "The Inbound server did not respond. Check the address and the phone's connection.");
      state.online = true;
      const data = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error("The Inbound server refused this phone. Rebuild the MiniApp with the server's access token."), { status: response.status });
      }
      if (!response.ok) {
        throw Object.assign(new Error(typeof data?.detail === "string" ? data.detail : `Inbound server returned ${response.status}`), { status: response.status });
      }
      if (data === null) throw new Error("The Mac address did not return an Inbound response.");
      return data as T;
    } catch (error) {
      if (!(error as { status?: number }).status) state.online = false;
      throw error;
    }
  }

  async function selectServer(address: string, allowFallback = false) {
    const candidates = allowFallback ? [...new Set([address, INBOUND_LOCAL_SERVER, INBOUND_SERVER].filter(Boolean))] : [address];
    for (const candidate of candidates) {
      try {
        const health = await request<MacHealth>(candidate, "/api/health", "GET", undefined, undefined, 3000);
        if (health.ok !== true) throw new Error("The address did not return an Inbound health check.");
        state.aiConfigured = !!health.ai_configured;
      } catch (error) {
        if (!allowFallback) throw error;
        continue;
      }
      if (candidate !== state.server) {
        state.server = candidate;
        void session.storage.set("server", candidate).catch(problem);
        void session.storage.set("serverBuild", INBOUND_SERVER).catch(() => {});
      }
      diagnostic("mac.connected", { connection: isPhoneRelay(candidate) ? "relay" : "local" });
      return candidate;
    }
    throw new Error("The phone could not reach Inbound. Check the Mac and your Wi-Fi connection.");
  }

  function updatePending() {
    state.pending = outbox.length;
    state.pendingBytes = outbox.reduce((total, job) => total + job.bytes, 0);
  }

  function enqueue(job: Omit<Job, "bytes" | "tries">) {
    outbox.push({ ...job, bytes: job.body.length, tries: 0 });
    // Keep memory bounded if the Mac stays unreachable: drop the oldest queued audio first.
    while (outbox.reduce((total, item) => total + item.bytes, 0) > OUTBOX_LIMIT) {
      const index = outbox.findIndex((item, position) => position > 0 && item.label.startsWith("audio"));
      if (index < 0) break;
      diagnostic("upload.dropped", { label: outbox[index].label, reason: "queue_full" });
      outbox.splice(index, 1)[0].done?.(false);
    }
    updatePending();
    void pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (outbox.length && !closed) {
        const job = outbox[0];
        try {
          await request(job.capture.server, job.path, "POST", job.body, job.contentType);
          outbox.shift();
          sent.set(job.capture, (sent.get(job.capture) ?? 0) + 1);
          if (job.tries) diagnostic("upload.recovered", { label: job.label, tries: job.tries });
          if (state.error.startsWith("Waiting for the server") || state.error.startsWith("The Inbound server refused")) state.error = "";
          job.done?.(true);
        } catch (error) {
          const status = (error as { status?: number }).status ?? 0;
          // The Mac understood and refused this request, or kept failing on it. Don't hold up later uploads.
          // A refused token keeps everything queued until the access problem is fixed.
          if ((status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status)) || (status >= 500 && job.tries >= 4)) {
            outbox.shift();
            diagnostic("upload.rejected", { label: job.label, status });
            problem(error, job.label);
            job.done?.(false);
          } else {
            job.tries++;
            if (job.tries === 1 || job.tries % 10 === 0) diagnostic("upload.retrying", { label: job.label, tries: job.tries, status });
            state.error = status === 401 || status === 403 ? (error as Error).message
              : `Waiting for the server. ${outbox.length} upload${outbox.length === 1 ? "" : "s"} will send automatically.`;
            updatePending();
            publish();
            await sleep(Math.min(8000, 500 * 2 ** Math.min(job.tries, 4)));
          }
        }
        updatePending();
        publish();
      }
    } finally {
      pumping = false;
    }
  }

  function save() {
    const value = state.capture ? JSON.stringify(state.capture) : null;
    const written = journalWrite.then(() => value ? session.storage.set("capture", value) : session.storage.delete("capture"));
    journalWrite = written.catch(() => {});
    return written;
  }

  function resetAudio() {
    audioChunks = [];
    audioChars = 0;
  }

  function flushAudio(capture: Capture) {
    if (!audioChunks.length) return;
    const seq = ++capture.audioSeq;
    const body = JSON.stringify({ seq, at: audioAt, sample_rate: audioRate, format: audioFormat ?? null, chunks: audioChunks });
    resetAudio();
    enqueue({ capture, path: `/api/sessions/${capture.id}/audio`, body, contentType: "application/json", label: `audio ${seq}` });
    void save().catch(() => {});
  }

  function start() {
    const capture: Capture = { id: crypto.randomUUID(), server: state.server, startedAt: Date.now(), audioSeq: 0, noteSeq: 0, photos: [] };
    // The session ID is made here, so recording starts instantly and the
    // create request simply waits in the queue if the Mac is unreachable.
    enqueue({
      capture, path: "/api/sessions", label: "session", contentType: "application/json",
      body: JSON.stringify({ id: capture.id, title: `Glasses capture · ${new Date().toLocaleTimeString()}`, source: "glasses", auto_report: true }),
    });
    resetAudio();
    streamAudio(true);
    state.capture = capture;
    state.phase = "recording";
    state.audio = false;
    state.error = "";
    state.message = "Recording. Say “snap” for a photo, then “stop” to send the report.";
    diagnostic("capture.started", { session: capture.id, glasses: state.connected });
    void save().catch(problem);
    if (state.videoEnabled && state.camera) startVideo(capture);
    else keepCameraWarm(capture);
    publish();
    if (!state.online) {
      void selectServer(state.server, true).then((server) => {
        if (!sent.get(capture) && server !== capture.server) {
          capture.server = server;
          void save().catch(() => {});
        }
        publish();
      }).catch(() => diagnostic("mac.unreachable", { session: capture.id }));
    }
  }

  function snap() {
    const capture = state.capture;
    if (!capture) return;
    if (capture.photos.length >= 40) {
      state.voiceCommand = "This capture already has 40 photos.";
      publish();
      return;
    }
    const photo: Photo = { seq: capture.photos.length + 1, seconds: elapsed(capture), status: "taking" };
    capture.photos.push(photo);
    diagnostic("photo.requested", { session: capture.id, number: photo.seq, seconds: photo.seconds });
    // Fire the shutter now rather than after the previous photo finishes transferring.
    const task = shoot(capture, photo, lastPhoto);
    lastPhoto = task;
    photoTasks.add(task);
    void task.finally(() => photoTasks.delete(task));
    publish();
  }

  async function shoot(capture: Capture, photo: Photo, previous: Promise<void>) {
    if (capture.video?.state === "starting") await videoStarting;
    if (capture.video && capture.video.state !== "failed") {
      // The glasses refuse photos while they record video. The still comes from
      // the video at this exact moment once the glasses upload it.
      photo.status = "from_video";
      diagnostic("photo.from_video", { session: capture.id, number: photo.seq });
      if (state.capture === capture) state.message = `Photo ${photo.seq} marked. Its still comes from the glasses video.`;
      publish();
      return;
    }
    if (state.capture === capture) state.message = `Taking photo ${photo.seq}…`;
    publish();
    await takePhoto(capture, photo, previous);
  }

  // A warm camera captures without its start-up delay. The glasses' video holds the
  // camera, so only photo-only captures warm it.
  function keepCameraWarm(capture: Capture) {
    clearTimeout(warmTimer);
    if (state.capture !== capture || (capture.video && capture.video.state !== "failed")) return;
    // Warming while a photo is being captured makes the glasses report busy.
    if (!photoTasks.size) {
      void session.camera.warmUp({ size: "medium", mode: "photo", durationMs: WARM_MS })
        .then(() => diagnostic("camera.warm", { session: capture.id }), (error: { code?: string }) => diagnostic("camera.warm_failed", { code: error?.code }));
    }
    warmTimer = setTimeout(() => keepCameraWarm(capture), WARM_MS - 10000);
  }

  async function download(url: string): Promise<Uint8Array | null> {
    try {
      const response = await withTimeout(fetch(url), 15000, "Photo download timed out.");
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  async function takePhoto(capture: Capture, photo: Photo, previous: Promise<void>) {
    const requestedAt = Date.now();
    // The glasses hold the camera until a photo has fully reached the phone, so transfer
    // speed decides how soon the next snap can fire. A photo kept on the phone
    // (`delivery: "local"`) always crosses Bluetooth, about 20 s each on Mentra Live.
    // With Wi-Fi, the standard path has the glasses upload it to Mentra's cloud in
    // seconds and falls back to Bluetooth itself; the phone then downloads it.
    let local = !state.wifi;
    const request = () => session.sendRequest<PhotoResult>({
      type: MiniappRequestType.PHOTO, size: "medium", mode: "photo", transferMethod: "auto", compress: "medium",
      sound: true, saveToGallery: false, ...(local ? { delivery: "local" } : {}),
    }, { timeoutMs: PHOTO_TIMEOUT_MS });
    try {
      let result: PhotoResult;
      try {
        result = await request();
      } catch (error) {
        const { code, message } = (error as { code?: string; message?: string }) ?? {};
        if (/busy/i.test(`${code} ${message}`)) {
          // The previous photo is still on its way to the phone. Take this one as soon as it arrives.
          diagnostic("photo.camera_busy", { session: capture.id, number: photo.seq });
          if (state.capture === capture) state.message = `Photo ${photo.seq} is next. The glasses are still sending the previous photo.`;
          publish();
          await previous;
        } else if (local) throw error;
        else {
          // Mentra's cloud was unreachable. Bring the photo over Bluetooth instead.
          diagnostic("photo.cloud_unavailable", { session: capture.id, number: photo.seq, code });
          local = true;
        }
        result = await request();
      }
      let bytes: Uint8Array | null = null;
      if (result?.key) {
        bytes = await session.blob.bytes(result.key).catch(() => null);
        void session.blob.delete(result.key).catch(() => {});
      } else if (result?.photoUrl?.startsWith("http")) bytes = await download(result.photoUrl);
      const url = [result?.photoUrl, result?.url].find(item => item && /^(?:https?|data):/.test(item));
      if (!bytes?.length && !url) throw new Error("The glasses did not return the photo.");
      photo.status = "uploading";
      diagnostic("photo.taken", { session: capture.id, number: photo.seq, elapsedMs: Date.now() - requestedAt, bytes: bytes?.length ?? 0, transfer: local ? "bluetooth" : "wifi" });
      if (state.capture === capture) state.message = `Photo ${photo.seq} taken. Sending it to the Mac.`;
      enqueue({
        capture, label: `photo ${photo.seq}`,
        path: `/api/sessions/${capture.id}/photos?seq=${photo.seq}&seconds=${photo.seconds}`,
        // When the phone can't read the image itself, the Mac fetches the link.
        ...(bytes?.length ? { body: bytes, contentType: result.mimeType || "image/jpeg" } : { body: JSON.stringify({ url }), contentType: "application/json" }),
        done: (ok) => { photo.status = ok ? "saved" : "failed"; publish(); },
      });
    } catch (error) {
      photo.status = "failed";
      problem(error, `photo ${photo.seq}`);
    }
  }

  function videoState(capture: Capture, video: CaptureVideo) {
    enqueue({
      capture, path: `/api/sessions/${capture.id}/video-state`, label: `video ${video.state}`, contentType: "application/json",
      body: JSON.stringify({ state: video.state, offset: video.offset ?? null, detail: video.detail?.slice(0, 300) ?? null }),
    });
    void save().catch(() => {});
    publish();
  }

  // Video is extra: the report comes from the phone's audio and photos even if the glasses never record or upload it.
  function startVideo(capture: Capture) {
    const video: CaptureVideo = { state: "starting" };
    capture.video = video;
    diagnostic("video.start_requested", { session: capture.id, wifi: state.wifi });
    const request = () => session.sendRequest<{ recordingId?: string }>({ type: MiniappRequestType.VIDEO_RECORDING_START, ...videoOptions }, { timeoutMs: VIDEO_START_TIMEOUT_MS });
    const started = request()
      .catch(async (error: { code?: string }) => {
        // A recording Mentra never released (say, after a failed upload) blocks every new one.
        const stale = await session.storage.get("videoRecording").catch(() => null);
        if (error?.code !== "ALREADY_RECORDING" || !stale) throw error;
        diagnostic("video.releasing_previous", { session: capture.id });
        await releaseVideo(stale);
        return request();
      })
      .then((result) => {
        if (!result?.recordingId) throw new Error("The glasses did not return a recording ID.");
        void session.storage.set("videoRecording", result.recordingId).catch(() => {});
        video.recordingId = result.recordingId;
        video.state = "recording";
        video.offset = elapsed(capture);
        diagnostic("video.started", { session: capture.id, offset: video.offset });
        videoState(capture, video);
        // Stop was said while the camera was still starting.
        if (state.capture !== capture) void stopVideo(capture);
      })
      .catch((error: { code?: string; message?: string }) => {
        video.state = "failed";
        video.detail = error?.code === "ALREADY_RECORDING"
          ? "Mentra still thinks an earlier video is recording. Fully quit and reopen the Mentra app to record video again. Photos and audio work meanwhile."
          : `The glasses did not start video. ${error?.message ?? ""} If the recording light is on, press the glasses' button to stop it.`.trim();
        diagnostic("video.start_failed", { session: capture.id, code: error?.code });
        videoState(capture, video);
        keepCameraWarm(capture);
      });
    // Snaps said while the camera starts wait to see whether video is recording.
    videoStarting = started;
  }

  async function releaseVideo(recordingId: string) {
    try {
      await session.camera.stopVideoRecording(recordingId);
    } catch (error) {
      diagnostic("video.release_failed", { code: (error as { code?: string })?.code });
      return false;
    }
    await session.storage.delete("videoRecording").catch(() => {});
    return true;
  }

  async function stopVideo(capture: Capture) {
    const video = capture.video;
    if (!video?.recordingId || video.state !== "recording") return;
    video.state = "stopping";
    publish();
    try {
      // The glasses upload the finished video themselves, over their own Wi-Fi.
      await session.camera.stopVideoRecording(video.recordingId, {
        uploadUrl: `${capture.server}/api/sessions/${capture.id}/video`,
        ...(INBOUND_TOKEN ? { uploadAuthToken: INBOUND_TOKEN } : {}),
      });
      video.state = "uploading";
      void session.storage.delete("videoRecording").catch(() => {});
      diagnostic("video.stopped", { session: capture.id, wifi: state.wifi });
    } catch (error) {
      const { code, message } = (error as { code?: string; message?: string }) ?? {};
      const uploadFailed = code === "media_error" || /upload/i.test(message ?? "");
      // Mentra can keep the recording after a failed upload. Stop it without a URL so it
      // saves to the gallery and frees the camera.
      if (uploadFailed) await releaseVideo(video.recordingId);
      video.state = "failed";
      // "failed to connect to /10.16.99.52 (port 8001) from /10.16.95.18": the glasses' network can't reach the server.
      const route = /failed to connect to \/([\d.]+).*? from \/([\d.]+)/.exec(message ?? "");
      video.detail = !uploadFailed ? message || "The glasses did not confirm the video stopped."
        : route ? `The glasses (${route[2]}) could not reach the server (${route[1]}) over Wi-Fi, so they are on a different network from it. Put the glasses on the server's Wi-Fi, or use one phone hotspot for the glasses, phone, and laptop. The video is saved in the Mentra gallery; you can attach it on the dashboard.`
        : "The glasses could not upload the video to the server over their Wi-Fi. It is saved in the Mentra gallery; you can attach it on the dashboard.";
      diagnostic("video.stop_failed", { session: capture.id, code, uploadFailed, error: (message ?? "").replace(/https?:\/\/\S+/g, "[address]").slice(0, 160) });
    }
    videoState(capture, video);
  }

  function stop() {
    const capture = state.capture;
    if (!capture) return;
    flushAudio(capture);
    streamAudio(false);
    if (state.heard && !state.heardFinal) note(capture, state.heard);
    const seconds = elapsed(capture);
    state.capture = null;
    state.phase = "ready";
    void stopVideo(capture);
    clearTimeout(warmTimer);
    state.delivered = { id: capture.id, server: capture.server, status: "uploading", progress: "Sending the last audio and photos to the Mac…" };
    state.message = "Stopped. Nothing more is recorded or sent. The report will appear on the dashboard.";
    diagnostic("capture.stopped", { session: capture.id, seconds, audio: capture.audioSeq, photos: capture.photos.length, notes: capture.noteSeq });
    void save().catch(problem);
    publish();
    // Finish only after the last photo is queued, so the Mac has everything when it starts the report.
    void Promise.allSettled([...photoTasks]).then(() => finish(capture, seconds));
  }

  function finish(capture: Capture, seconds: number) {
    enqueue({
      capture, path: `/api/sessions/${capture.id}/finish`, label: "finish", contentType: "application/json",
      body: JSON.stringify({
        audio_parts: capture.audioSeq, notes: capture.noteSeq, photos: capture.photos.filter(photo => photo.status !== "failed").length, seconds,
        video_frames: capture.photos.filter(photo => photo.status === "from_video").map(({ seq, seconds }) => ({ seq, seconds })),
      }),
      done: (ok) => {
        if (state.delivered?.id !== capture.id) return;
        state.delivered = { ...state.delivered, status: ok ? "processing" : "failed", progress: ok ? "Preparing the report on the Mac…" : "The Mac could not finish this capture. Open the dashboard to retry." };
        publish();
      },
    });
  }

  function note(capture: Capture, text: string) {
    const seq = ++capture.noteSeq;
    enqueue({
      capture, path: `/api/sessions/${capture.id}/notes`, label: `note ${seq}`, contentType: "application/json",
      body: JSON.stringify({ seq, seconds: elapsed(capture), text: text.slice(0, 2000) }),
    });
  }

  async function checkDelivered() {
    const delivered = state.delivered;
    if (!delivered || delivered.status === "uploading") return;
    // Keep following a finished report while the glasses' video is still on its way.
    if (finished.has(delivered.status) && !["recording", "uploading"].includes(delivered.video ?? "")) return;
    if (outbox.some(job => job.capture.id === delivered.id)) return;
    try {
      const result = await request<{ status: string; progress: string; error?: string; video?: { state: string } }>(delivered.server, `/api/sessions/${delivered.id}`);
      if (state.delivered?.id !== delivered.id) return;
      const progress = result.status === "complete" ? "Report ready on the Mac dashboard."
        : result.status === "awaiting_key" ? "Saved on the Mac. Add the OpenAI key there to generate the report."
        : result.error || result.progress;
      const video = result.video?.state;
      if (result.status !== delivered.status || progress !== delivered.progress || video !== delivered.video) {
        state.delivered = { ...delivered, status: result.status, progress, video };
        diagnostic("mac.capture_status", { session: delivered.id, status: result.status });
        publish();
      }
    } catch {
      // The status check repeats; uploads report their own connection errors.
    }
  }

  async function run(work: () => void | Promise<void>) {
    if (!hydrated || state.busy) return;
    state.busy = true;
    state.error = "";
    publish();
    try { await work(); } catch (error) { problem(error); }
    finally {
      state.busy = false;
      publish();
    }
  }

  function dispatch(command: Command, source: "voice" | "button" = "button") {
    diagnostic("command.received", { command, source });
    const feedback = (message: string) => {
      if (source === "voice") state.voiceCommand = message;
      publish();
    };
    if (!hydrated) return feedback(`Heard “${command}”. Inbound is still loading.`);
    if (command === "start") {
      if (state.capture) return feedback("Heard “start”. Already recording.");
      start();
    } else if (command === "snap") {
      if (!state.capture) return feedback("Heard “snap”. Say “start” first.");
      snap();
    } else {
      if (!state.capture) return feedback("Heard “stop”. Nothing is recording.");
      stop();
    }
    diagnostic("command.accepted", { command, source });
    feedback(`Voice command accepted: ${command}`);
  }

  // Command words count anywhere in a sentence, as soon as they are heard.
  // Each occurrence in an utterance fires once, even as partial results repeat it.
  function scan(final: boolean) {
    clearTimeout(settleTimer);
    let waiting = false;
    for (const hit of findCommands(words)) {
      if (hit.occurrence <= (fired.get(hit.command) ?? 0)) continue;
      if (!final && hit.index === words.length - 1) {
        waiting = true;
        continue;
      }
      fired.set(hit.command, hit.occurrence);
      // A recognizer can restart an utterance and repeat a word it already gave us.
      if (hit.occurrence === 1 && lastVoice?.command === hit.command && Date.now() - lastVoice.at < REPEAT_MS) {
        diagnostic("speech.repeat_ignored", { command: hit.command });
        continue;
      }
      lastVoice = { command: hit.command, at: Date.now() };
      dispatch(hit.command, "voice");
    }
    if (waiting) settleTimer = setTimeout(() => scan(true), SETTLE_MS);
  }

  function resetSpeech() {
    clearTimeout(settleTimer);
    words = [];
    fired = new Map();
  }

  session.transcription.forLanguage("en-US", (data) => {
    const text = data.text ?? "";
    const next = speechWords(text);
    if (!next.length) return;
    if (state.voice === "Waiting for the on-device English speech model") state.voice = "Voice commands ready";
    if (data.isFinal) {
      if (text === lastFinal.text && Date.now() - lastFinal.at < REPEAT_MS) return;
      lastFinal = { text, at: Date.now() };
    }
    // A hypothesis that starts differently is a new utterance.
    if (!words.length || next[0] !== words[0]) fired = new Map();
    words = next;
    state.heard = text.slice(0, 180);
    state.heardFinal = data.isFinal;
    const hits = findCommands(words).map(hit => hit.command).join(",");
    if (data.isFinal || hits) diagnostic("speech.transcript", { final: data.isFinal, words: words.length, commands: hits || "none", source: data.source });
    const capture = state.capture;
    scan(data.isFinal);
    if (data.isFinal) {
      // The sentence that said "start" or "stop" belongs to that capture too.
      const target = capture ?? state.capture;
      if (target) note(target, text);
      resetSpeech();
    }
    publish();
  }, { processing: "localOnly" });

  function receiveAudio(chunk: { data: string; sampleRate?: number; format?: string }) {
    const capture = state.capture;
    if (!capture || !chunk?.data) return;
    const rate = chunk.sampleRate || 16000;
    if (audioChunks.length && (rate !== audioRate || chunk.format !== audioFormat)) flushAudio(capture);
    if (!audioChunks.length) {
      audioAt = elapsed(capture);
      audioBatchStarted = Date.now();
    }
    audioRate = rate;
    audioFormat = chunk.format;
    audioChunks.push(chunk.data);
    audioChars += chunk.data.length;
    if (!state.audio) {
      state.audio = true;
      diagnostic("audio.flowing", { session: capture.id, rate, format: chunk.format });
      publish();
    }
    if (audioChars >= AUDIO_FLUSH_CHARS) flushAudio(capture);
  }

  // Raw audio is wanted only between Start and Stop. While it is subscribed, Mentra has
  // the glasses send a second, uncompressed stream; voice commands need only the first.
  let stopAudio: (() => void) | null = null;
  function streamAudio(on: boolean) {
    if (on && !stopAudio) stopAudio = session.mic.onAudioChunk(receiveAudio);
    else if (!on && stopAudio) {
      stopAudio();
      stopAudio = null;
    }
  }

  session.ui.handle("getState", snapshot);
  session.ui.handle("copyDiagnostics", () => session.system.copyToClipboard(state.diagnostics.join("\n")));
  session.ui.onOpen(publish);
  session.ui.on("command", ({ command }) => dispatch(command));
  session.ui.on("connect", ({ server }) => { void run(async () => {
    await selectServer(serverOrigin(server));
    const capture = state.capture;
    if (capture && !sent.get(capture)) capture.server = state.server;
    state.message = "Mac connected. Say “start” to record.";
  }); });
  session.ui.on("video", ({ enabled }) => {
    if (typeof enabled !== "boolean") return;
    state.videoEnabled = enabled;
    void session.storage.set("video", enabled ? "on" : "off").catch(problem);
    publish();
  });
  session.ui.on("wifi", () => { void run(() => session.glasses.requestWifiSetup("Inbound's glasses upload their video to the server over Wi-Fi.")); });
  session.ui.on("report", () => {
    const target = state.capture ?? state.delivered;
    const base = target?.server || state.server;
    if (base) session.system.openUrl(base + (target ? `/#${target.id}` : "/"));
  });
  session.glasses.onConnection((data) => {
    if (state.connected !== data.connected) diagnostic("glasses.connection", { connected: data.connected, model: data.modelName });
    state.connected = data.connected;
    if (!data.connected) resetSpeech();
    publish();
  });
  session.glasses.onBattery((data) => { state.battery = data.level; publish(); });
  session.glasses.onWifi((data) => {
    const network = data.connected ? [data.ssid, data.localIp].filter(Boolean).join(" · ") : "";
    if (state.wifi !== data.connected || state.glassesNetwork !== network) diagnostic("glasses.wifi", { connected: data.connected, ssid: data.ssid, ip: data.localIp });
    state.wifi = data.connected;
    state.glassesNetwork = network;
    publish();
  });
  session.on("ready", () => {
    state.camera = !!session.capabilities?.hasCamera;
    diagnostic("mentra.ready", { camera: state.camera });
    publish();
    // Keep the mic stream continuous so quiet command words still reach the recognizer.
    for (const [gate, apply] of [
      ["loudness", () => session.mic.setLoudnessGateEnabled(false)],
      ["glasses_vad", () => session.mic.setVoiceActivityDetectionEnabled(false)],
    ] as const) {
      void apply().then(() => diagnostic("speech.mic_gate_off", { gate })).catch((error: { code?: string }) => {
        diagnostic("speech.mic_gate_unavailable", { gate, code: error?.code });
      });
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
    if (model.language && model.language !== "en-US") state.voice = "Select English for speech recognition in Mentra’s Speech settings.";
    else if (model.state === "ready") state.voice = "Voice commands ready";
    else if (model.state === "downloading") state.voice = `Downloading English speech model · ${Math.round(model.progress || 0)}%`;
    else state.voice = model.reason || `English speech model ${model.state}`;
    diagnostic("speech.model", { state: model.state, language: model.language });
    publish();
  });

  try {
    const savedServer = await session.storage.get("server");
    // A new build's server address replaces one saved under a different or older build.
    const savedBuild = await session.storage.get("serverBuild");
    state.server = savedServer && !isPhoneRelay(savedServer) && savedBuild === INBOUND_SERVER ? savedServer : INBOUND_SERVER;
    state.videoEnabled = (await session.storage.get("video")) !== "off";
    const journal = await session.storage.get("capture");
    if (journal) {
      // The MiniApp closed mid-capture. Queued uploads were lost with it; ask
      // the Mac to build the report from what already arrived.
      const capture = JSON.parse(journal) as Capture;
      state.delivered = { id: capture.id, server: capture.server, status: "uploading", progress: "Finishing the previous capture…" };
      finish(capture, elapsed(capture));
      await session.storage.delete("capture");
      diagnostic("capture.recovered", { session: capture.id });
    }
  } catch (error) { problem(error); }
  hydrated = true;
  diagnostic("capture.ready", { addressChanged: state.server !== INBOUND_SERVER });
  publish();
  void selectServer(state.server, true).then(publish).catch(() => publish());

  const ticker = setInterval(() => {
    const capture = state.capture;
    if (capture && audioChunks.length && Date.now() - audioBatchStarted >= AUDIO_FLUSH_MS) flushAudio(capture);
    if (Date.now() - lastStatusCheck >= 2000) {
      lastStatusCheck = Date.now();
      void checkDelivered();
    }
  }, 1000);
  session.on("disconnect", () => { closed = true; streamAudio(false); resetSpeech(); clearTimeout(warmTimer); clearInterval(ticker); });
});
