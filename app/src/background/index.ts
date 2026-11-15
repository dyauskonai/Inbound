import { MiniappRequestType, registerMiniapp } from "@mentra/miniapp/background";
import type { Capture, CaptureVideo, Channels, ChatMessage, Command, Photo, State, Vital } from "../shared/channels";
import { findCommands, isPhoneRelay, serverOrigin, speechWords } from "../shared/commands";
import { findVitals, spokenValue, UNCLEAR, vitalNames, type VitalKind, type VitalReading } from "../shared/vitals";

declare const INBOUND_SERVER: string;
declare const INBOUND_LOCAL_SERVER: string;
// Set when the build targets an internet server; that server refuses requests without it.
declare const INBOUND_TOKEN: string;

type MacHealth = { ok: boolean; ai_configured?: boolean; video_upload_url?: string | null };
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
// 720p at 30 fps: enough detail for the ER. `save` keeps a copy in the glasses' gallery.
const videoOptions = { width: 1280, height: 720, fps: 30, save: true, sound: false };
// Stop resolves only after the glasses finish uploading, so allow for a long video on slow Wi-Fi.
const VIDEO_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
// Cloudflare refuses uploads over ~100 MB, and 720p30 from Mentra Live is ~39 MB a minute. A failed
// upload also leaves Mentra holding the recording until it restarts, so over the internet the video
// stops at 2:20 while audio, photos, and vitals carry on.
const VIDEO_INTERNET_LIMIT_MS = 140_000;
// A command word at the end of a partial transcript can still grow ("stop" → "stopped").
const SETTLE_MS = 350;
const REPEAT_MS = 1500;
const finished = new Set(["complete", "awaiting_key", "failed", "interrupted"]);
// Two different values for one vital this close together are a correction ("190 over 60…
// no, 90 over 60"), so the glasses ask the medic to say it again and log the answer.
const CORRECTION_WINDOW_MS = 45000;
const REPEAT_WAIT_MS = 20000;
// The glasses' microphone hears their own speaker. Vitals heard while they talk, and just
// after, are their own read-back.
const ECHO_TAIL_MS = 2000;
// Between captures the phone checks for messages from the ER this often.
const MESSAGE_POLL_MS = 3000;
// After an ER message the medic has this long to start answering, and a pause this long ends the answer.
const ANSWER_WAIT_MS = 20000;
const ANSWER_SETTLE_MS = 1800;

registerMiniapp<Channels>(async (session) => {
  const state: State = {
    phase: "ready", server: INBOUND_SERVER, defaultServer: INBOUND_SERVER,
    online: false, aiConfigured: false, camera: false, connected: false, wifi: false, glassesNetwork: "", glassesIp: "", videoUploadBase: "", uploadCheck: "", videoEnabled: true, battery: null, audio: false,
    voice: "Waiting for the on-device English speech model", voiceCommand: "", heard: "", heardFinal: false,
    message: "Say “start” to begin. Nothing is recorded or sent until then.", error: "",
    capture: null, vitals: [], delivered: null, conversation: null, pending: 0, pendingBytes: 0, busy: false, diagnostics: [],
  };
  let hydrated = false;
  let closed = false;
  // Photos in flight. Stop sends finish only after all of them settle.
  const photoTasks = new Set<Promise<void>>();
  let lastPhoto: Promise<void> = Promise.resolve();
  let videoStarting: Promise<void> | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  let videoLimit: ReturnType<typeof setTimeout> | undefined;
  // Mentra blocks new recordings until the last video finishes uploading.
  let uploading: Promise<void> | null = null;
  const videoRecording = (capture: Capture) => capture.video?.state === "starting" || capture.video?.state === "recording";
  let checking = false;
  // `settled`: the medic confirmed or deliberately changed it. A later value replaces it.
  const lastVitals = new Map<VitalKind, { value: string; at: number; settled: boolean }>();
  let speech = Promise.resolve(true);
  // `unlikely`: numbers the medic gave that were clear but out of range, like "sats twenty".
  type Repeat = { capture: Capture; kind: VitalKind; candidates: string[]; unlikely: string[]; asks: number; timer?: ReturnType<typeof setTimeout> };
  let repeat: Repeat | null = null;
  const repeatQueue: Repeat[] = [];
  let speakingUntil = 0;
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
  // The finished capture the ER can ask about, and the reply the medic is giving.
  let talk: Capture | null = null;
  const announced = new Set<string>();
  type Reply = { capture: Capture; id: string; to: string; question: string; parts: string[]; photo?: Promise<boolean>; wait?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout> };
  let replying: Reply | null = null;
  let lastMessageCheck = 0;
  let checkingMessages = false;
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
        state.videoUploadBase = health.video_upload_url?.replace(/\/+$/, "") ?? "";
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
    const capture: Capture = {
      id: crypto.randomUUID(), server: state.server, startedAt: Date.now(), audioSeq: 0, noteSeq: 0, photos: [], vitalSeq: 0,
      uploadToken: (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ""),
    };
    // The session ID is made here, so recording starts instantly and the
    // create request simply waits in the queue if the Mac is unreachable.
    enqueue({
      capture, path: "/api/sessions", label: "session", contentType: "application/json",
      body: JSON.stringify({ id: capture.id, title: `Glasses capture · ${new Date().toLocaleTimeString()}`, source: "glasses", auto_report: true, upload_token: capture.uploadToken }),
    });
    resetAudio();
    streamAudio(true);
    lastVitals.clear();
    state.vitals = [];
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
    // Also refreshes the server's video upload address, which changes whenever its tunnel restarts.
    void selectServer(state.server, true).then((server) => {
      if (!sent.get(capture) && server !== capture.server) {
        capture.server = server;
        void save().catch(() => {});
      }
      publish();
    }).catch(() => diagnostic("mac.unreachable", { session: capture.id }));
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
    if (videoRecording(capture)) {
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
    if (state.capture !== capture || videoRecording(capture)) return;
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

  type Shot = { bytes: Uint8Array | null; url?: string; mimeType?: string; local: boolean };

  // One photo from the glasses. They hold the camera until a photo has fully reached the
  // phone, so transfer speed decides how soon the next one can fire. A photo kept on the
  // phone (`delivery: "local"`) always crosses Bluetooth, about 20 s each on Mentra Live.
  // With Wi-Fi, the standard path has the glasses upload it to Mentra's cloud in seconds
  // and falls back to Bluetooth itself; the phone then downloads it.
  async function grabPhoto(about: { session: string; number: number }, busy: () => void, previous: Promise<void>): Promise<Shot> {
    let local = !state.wifi;
    const request = () => session.sendRequest<PhotoResult>({
      type: MiniappRequestType.PHOTO, size: "medium", mode: "photo", transferMethod: "auto", compress: "medium",
      sound: true, saveToGallery: false, ...(local ? { delivery: "local" } : {}),
    }, { timeoutMs: PHOTO_TIMEOUT_MS });
    let result: PhotoResult;
    try {
      result = await request();
    } catch (error) {
      const { code, message } = (error as { code?: string; message?: string }) ?? {};
      if (/busy/i.test(`${code} ${message}`)) {
        // The previous photo is still on its way to the phone. Take this one as soon as it arrives.
        diagnostic("photo.camera_busy", about);
        busy();
        await previous;
      } else if (local) throw error;
      else {
        // Mentra's cloud was unreachable. Bring the photo over Bluetooth instead.
        diagnostic("photo.cloud_unavailable", { ...about, code });
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
    return { bytes, url, mimeType: result.mimeType, local };
  }

  // When the phone can't read the image itself, the Mac fetches the link.
  const photoBody = (shot: Shot) => shot.bytes?.length
    ? { body: shot.bytes, contentType: shot.mimeType || "image/jpeg" }
    : { body: JSON.stringify({ url: shot.url }), contentType: "application/json" };

  async function takePhoto(capture: Capture, photo: Photo, previous: Promise<void>) {
    const requestedAt = Date.now();
    try {
      const shot = await grabPhoto({ session: capture.id, number: photo.seq }, () => {
        if (state.capture === capture) state.message = `Photo ${photo.seq} is next. The glasses are still sending the previous photo.`;
        publish();
      }, previous);
      photo.status = "uploading";
      diagnostic("photo.taken", { session: capture.id, number: photo.seq, elapsedMs: Date.now() - requestedAt, bytes: shot.bytes?.length ?? 0, transfer: shot.local ? "bluetooth" : "wifi" });
      if (state.capture === capture) state.message = `Photo ${photo.seq} taken. Sending it to the Mac.`;
      enqueue({
        capture, label: `photo ${photo.seq}`,
        path: `/api/sessions/${capture.id}/photos?seq=${photo.seq}&seconds=${photo.seconds}`,
        ...photoBody(shot),
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

  // Start a glasses recording. A recording Mentra never released (say, after a failed
  // upload) blocks every new one, so release the last one Inbound started and retry.
  async function startRecording(): Promise<string> {
    const request = () => session.sendRequest<{ recordingId?: string }>({ type: MiniappRequestType.VIDEO_RECORDING_START, ...videoOptions }, { timeoutMs: VIDEO_START_TIMEOUT_MS });
    let result: { recordingId?: string };
    try {
      result = await request();
    } catch (error) {
      const stale = await session.storage.get("videoRecording").catch(() => null);
      // While that recording is still uploading, leave it alone: it isn't stuck, just busy.
      if ((error as { code?: string })?.code !== "ALREADY_RECORDING" || !stale || uploading) throw error;
      diagnostic("video.releasing_previous");
      await releaseVideo(stale);
      result = await request();
    }
    if (!result?.recordingId) throw new Error("The glasses did not return a recording ID.");
    void session.storage.set("videoRecording", result.recordingId).catch(() => {});
    return result.recordingId;
  }

  // The glasses upload the video themselves, over their own Wi-Fi. When they share the
  // server's subnet they use its local address; otherwise the server's internet tunnel,
  // so their Wi-Fi then only needs internet.
  function uploadRoute(server: string): { base: string; route: "local" | "internet" } {
    const subnet = (address: string) => /(?:^|\/\/)(\d+\.\d+\.\d+)\.\d+/.exec(address)?.[1];
    const glasses = subnet(state.glassesIp);
    return state.videoUploadBase && !(glasses && glasses === subnet(server))
      ? { base: state.videoUploadBase, route: "internet" }
      : { base: server, route: "local" };
  }

  // Stop resolves only after the glasses finish uploading. A failed upload can leave Mentra
  // holding the recording, so release it to save the clip to the gallery and free the camera.
  function stopAndUpload(recordingId: string, url: string, token: string) {
    const upload = (async () => {
      try {
        await session.sendRequest<void>({ type: MiniappRequestType.VIDEO_RECORDING_STOP, recordingId, uploadUrl: url, uploadAuthToken: token }, { timeoutMs: VIDEO_UPLOAD_TIMEOUT_MS });
      } catch (error) {
        const { code, message } = (error as { code?: string; message?: string }) ?? {};
        if (code === "media_error" || /upload/i.test(message ?? "")) await releaseVideo(recordingId);
        throw error;
      }
      void session.storage.delete("videoRecording").catch(() => {});
    })();
    const tracked = upload.then(() => {}, () => {});
    uploading = tracked;
    void tracked.then(() => { if (uploading === tracked) uploading = null; });
    return upload;
  }

  function uploadProblem(error: unknown): string {
    const { code, message } = (error as { code?: string; message?: string }) ?? {};
    // "failed to connect to /10.16.99.52 (port 8001) from /10.16.95.18": no route from the glasses' network.
    const route = /failed to connect to \/([\d.]+).*? from \/([\d.]+)/.exec(message ?? "");
    const network = state.glassesNetwork ? ` (${state.glassesNetwork})` : "";
    if (route) return `The glasses (${route[2]}) could not reach ${state.videoUploadBase ? "the upload address" : `the server (${route[1]})`}. Their Wi-Fi${network} blocks it.`;
    if (code === "ACTION_TIMEOUT") return `The glasses did not finish uploading. Their Wi-Fi${network} may need a sign-in page, as Stanford Visitor does, which glasses can't open.`;
    if (code === "media_error" || /upload/i.test(message ?? "")) return `The glasses could not upload over their Wi-Fi${network}. ${(message ?? "").replace(/https?:\/\/\S+/g, "the server")}`.trim();
    return message || "The glasses did not confirm the video stopped.";
  }

  // Video is extra: the report comes from the phone's audio and photos even if the glasses never record or upload it.
  function startVideo(capture: Capture) {
    const video: CaptureVideo = { state: "starting" };
    capture.video = video;
    diagnostic("video.start_requested", { session: capture.id, wifi: state.wifi });
    const started = startRecording()
      .then((recordingId) => {
        video.recordingId = recordingId;
        video.state = "recording";
        video.offset = elapsed(capture);
        diagnostic("video.started", { session: capture.id, offset: video.offset });
        videoState(capture, video);
        // Stop was said while the camera was still starting.
        if (state.capture !== capture) {
          void stopVideo(capture);
          return;
        }
        clearTimeout(videoLimit);
        videoLimit = setTimeout(() => {
          // The route is checked now: the tunnel's address can arrive after recording started.
          if (state.capture !== capture || video.state !== "recording" || uploadRoute(capture.server).route !== "internet") return;
          diagnostic("video.limit_reached", { session: capture.id });
          state.message = "Video stopped at 2:20 to fit the internet upload. Audio, photos, and vitals are still recording.";
          void stopVideo(capture);
          keepCameraWarm(capture);
          publish();
        }, VIDEO_INTERNET_LIMIT_MS);
      })
      .catch((error: { code?: string; message?: string }) => {
        const previous = uploading;
        if (error?.code === "ALREADY_RECORDING" && previous) {
          // Not stuck: the glasses are sending the last capture's video. Start this one when they're done.
          video.state = "failed";
          video.detail = "The glasses are still uploading the previous video. Video starts here as soon as that finishes.";
          diagnostic("video.waiting_for_upload", { session: capture.id });
          videoState(capture, video);
          if (state.capture === capture) state.message = video.detail;
          keepCameraWarm(capture);
          void previous.then(() => {
            if (state.capture === capture && capture.video === video) startVideo(capture);
          });
          return;
        }
        video.state = "failed";
        video.detail = error?.code === "ALREADY_RECORDING"
          ? "Mentra still thinks an earlier video is recording. Fully quit and reopen the Mentra app to record video again. Photos and audio work meanwhile."
          : `The glasses did not start video. ${error?.message ?? ""} If the recording light is on, press the glasses' button to stop it.`.trim();
        // Say so where the medic looks: until Mentra restarts, every capture will be missing video.
        if (state.capture === capture) state.error = `No video for this capture. ${video.detail}`;
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
    const { base, route } = uploadRoute(capture.server);
    // The dashboard shows the upload in progress; the server marks the video ready when it lands.
    video.state = "uploading";
    videoState(capture, video);
    const requestedAt = Date.now();
    diagnostic("video.upload_started", { session: capture.id, route, glasses: state.glassesNetwork });
    try {
      await stopAndUpload(video.recordingId, `${base}/api/sessions/${capture.id}/video`, INBOUND_TOKEN || capture.uploadToken);
      diagnostic("video.uploaded", { session: capture.id, route, elapsedMs: Date.now() - requestedAt });
    } catch (error) {
      const { code, message } = (error as { code?: string; message?: string }) ?? {};
      video.state = "failed";
      video.detail = `${uploadProblem(error)} The video is saved in the Mentra gallery; you can attach it on the dashboard.`;
      diagnostic("video.upload_failed", { session: capture.id, route, code, elapsedMs: Date.now() - requestedAt, error: (message ?? "").replace(/https?:\/\/\S+/g, "[address]").slice(0, 160) });
      videoState(capture, video);
    }
  }

  // Record a 3-second clip and send it the way a capture's video goes, to prove the
  // glasses can deliver video before it matters.
  async function checkVideoUpload() {
    if (state.capture) throw new Error("Finish the current capture before testing the video upload.");
    if (!state.camera) throw new Error("Connect Mentra Live glasses in the Mentra app first.");
    const id = crypto.randomUUID();
    const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    const report = (message: string) => { state.uploadCheck = message; publish(); };
    checking = true;
    try {
      const server = await selectServer(state.server, true);
      await request(server, "/api/sessions", "POST", JSON.stringify({ id, source: "glasses", title: "Video upload check", check: true, upload_token: token }));
      report("Recording a 3-second test clip on the glasses…");
      const recordingId = await startRecording();
      await sleep(3000);
      const { base, route } = uploadRoute(server);
      report(route === "internet" ? "Uploading the test clip over the internet…" : "Uploading the test clip over local Wi-Fi…");
      const startedAt = Date.now();
      try {
        await stopAndUpload(recordingId, `${base}/api/sessions/${id}/video`, INBOUND_TOKEN || token);
      } catch (error) {
        diagnostic("video.check_failed", { route, code: (error as { code?: string })?.code });
        report(`✗ ${uploadProblem(error)} Put the glasses on a phone hotspot with internet, then test again.`);
        return;
      }
      const result = await request<{ video?: { state?: string; bytes?: number; duration?: number } }>(server, `/api/sessions/${id}`);
      const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
      if (result.video?.state !== "ready") {
        report("✗ The glasses reported success, but the server has no video. Check the server log.");
        return;
      }
      const perMinute = result.video.bytes && result.video.duration ? result.video.bytes / result.video.duration * 60 / 1e6 : 0;
      diagnostic("video.check_passed", { route, seconds, mbPerMinute: Math.round(perMinute) });
      report(`✓ The glasses uploaded a test clip over ${route === "internet" ? "the internet" : "local Wi-Fi"} in ${seconds} s.${perMinute ? ` Video is about ${Math.round(perMinute)} MB per minute.` : ""}`);
    } finally {
      checking = false;
    }
  }

  function stop() {
    const capture = state.capture;
    if (!capture) return;
    flushAudio(capture);
    streamAudio(false);
    endRepeats();
    if (state.heard && !state.heardFinal) note(capture, state.heard);
    const seconds = elapsed(capture);
    state.capture = null;
    state.phase = "ready";
    void stopVideo(capture);
    clearTimeout(warmTimer);
    clearTimeout(videoLimit);
    state.delivered = { id: capture.id, server: capture.server, status: "uploading", progress: "Sending the last audio and photos to the Mac…" };
    converse(capture);
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

  // Speak through the glasses (the phone's audio route). Listening for vitals pauses meanwhile.
  // One phrase at a time: a new one would cut off the one playing.
  function say(text: string): Promise<boolean> {
    const spoken = speech.then(async () => {
      speakingUntil = Number.POSITIVE_INFINITY;
      try {
        await session.speaker.speak(text, { processing: "preferLocal" });
        diagnostic("speech.said", { words: text.split(" ").length });
        return true;
      } catch (error) {
        diagnostic("speech.say_failed", { code: (error as { code?: string })?.code });
        return false;
      } finally {
        speakingUntil = Date.now() + ECHO_TAIL_MS;
      }
    });
    speech = spoken;
    return spoken;
  }

  function logVital(capture: Capture, kind: VitalKind, value: string, status: Vital["status"], candidates: string[] = []) {
    const seq = ++capture.vitalSeq;
    enqueue({
      capture, path: `/api/sessions/${capture.id}/vitals`, label: `vital ${seq}`, contentType: "application/json",
      body: JSON.stringify({ seq, kind, value, status, seconds: elapsed(capture), candidates }),
    });
    // Kind and status only: diagnostics leave out clinical values, as they do transcripts.
    diagnostic("vital.logged", { session: capture.id, kind, status });
    if (state.capture === capture) {
      state.vitals = [...state.vitals.filter(vital => vital.kind !== kind), { kind, value, status, ...(candidates.length ? { candidates } : {}) }];
      publish();
    }
  }

  // Ask whenever a vital is unclear or was given two different values close together;
  // otherwise log it as heard.
  function heardVitals(capture: Capture, text: string) {
    if (Date.now() < speakingUntil) return;
    const live = capture === state.capture;
    const open = repeat?.capture === capture ? repeat : null;
    const readings = findVitals(text, open?.kind);
    if (open) {
      const answer = readings.filter(reading => reading.kind === open.kind);
      if (answer.length) answerRepeat(open, answer);
    }
    for (const kind of new Set(readings.map(reading => reading.kind))) {
      if (kind === open?.kind) continue;
      const said = readings.filter(reading => reading.kind === kind);
      const clear = [...new Set(said.filter(reading => !reading.unclear).map(reading => reading.value))];
      const last = lastVitals.get(kind);
      // A quick change to a value nobody has confirmed is a correction, so ask.
      const correcting = last && !last.settled && Date.now() - last.at < CORRECTION_WINDOW_MS;
      const values = [...new Set([...(correcting ? [last.value] : []), ...clear])];
      const unclear = said.some(reading => reading.unclear);
      if (live && (unclear || values.length > 1)) {
        if (clear.length) lastVitals.set(kind, { value: clear.at(-1)!, at: Date.now(), settled: false });
        askToRepeat(capture, kind, unclear ? [...values, UNCLEAR] : values, said.flatMap(reading => reading.heard ?? []));
        continue;
      }
      for (const value of clear) {
        if (live && last && last.value !== value) {
          // The medic changed a logged value: the newest wins, read back so a mishearing gets caught.
          lastVitals.set(kind, { value, at: Date.now(), settled: true });
          logVital(capture, kind, value, "updated", [last.value, value]);
          const name = vitalNames[kind];
          state.voiceCommand = `Changed the ${name} from ${last.value} to ${value}.`;
          void say(`${name[0].toUpperCase()}${name.slice(1)} updated to ${spokenValue(kind, value)}.`);
        } else {
          lastVitals.set(kind, { value, at: Date.now(), settled: last?.settled ?? false });
          logVital(capture, kind, value, "heard");
        }
      }
    }
  }

  // One clear value answers the question. Another unclear or conflicting answer is asked again.
  // An unlikely number said again when asked is what the medic means: "sats twenty", twice.
  function answerRepeat(request: Repeat, answer: VitalReading[]) {
    const clear = [...new Set(answer.filter(reading => !reading.unclear).map(reading => reading.value))];
    if (clear.length === 1 && !answer.some(reading => reading.unclear)) {
      confirmRepeat(clear[0]);
      return;
    }
    const insisted = answer.find(reading => reading.heard && request.unlikely.includes(reading.heard))?.heard;
    if (insisted && !clear.length) {
      confirmRepeat(insisted);
      return;
    }
    request.unlikely = [...new Set([...request.unlikely, ...answer.flatMap(reading => reading.heard ?? [])])];
    clearTimeout(request.timer);
    request.candidates = [...new Set([...request.candidates, ...clear, ...(answer.some(reading => reading.unclear) ? [UNCLEAR] : [])])];
    diagnostic("vital.answer_unclear", { session: request.capture.id, kind: request.kind, asks: request.asks });
    if (request.asks < 3) void prompt(request);
    else {
      settleRepeat("answer still unclear");
      nextRepeat();
    }
  }

  const lastClear = (candidates: string[]) => candidates.filter(value => value !== UNCLEAR).at(-1) ?? "";

  function askToRepeat(capture: Capture, kind: VitalKind, candidates: string[], unlikely: string[] = []) {
    logVital(capture, kind, lastClear(candidates), "conflict", candidates);
    const request: Repeat = { capture, kind, candidates, unlikely, asks: 0 };
    if (repeat) repeatQueue.push(request);
    else {
      repeat = request;
      void prompt(request);
    }
  }

  async function prompt(request: Repeat) {
    request.asks++;
    state.voiceCommand = `Asking the medic to repeat the ${vitalNames[request.kind]}. Heard ${request.candidates.join(", then ")}.`;
    publish();
    await say(`${request.asks > 1 ? "Sorry, " : ""}${request.asks > 1 ? "can" : "Can"} you repeat the ${vitalNames[request.kind]}?`);
    if (repeat !== request) return;
    request.timer = setTimeout(() => {
      if (repeat !== request) return;
      // Ask once more, then leave it for the ER to check.
      if (request.asks < 2) void prompt(request);
      else {
        settleRepeat("no answer");
        nextRepeat();
      }
    }, REPEAT_WAIT_MS);
  }

  function confirmRepeat(value: string) {
    const request = repeat!;
    clearTimeout(request.timer);
    repeat = null;
    lastVitals.set(request.kind, { value, at: Date.now(), settled: true });
    logVital(request.capture, request.kind, value, "confirmed", request.candidates);
    const name = vitalNames[request.kind];
    state.voiceCommand = `Logged the ${name} as ${value}.`;
    publish();
    void say(`${name[0].toUpperCase()}${name.slice(1)} ${spokenValue(request.kind, value)}, logged.`).then(nextRepeat);
  }

  function settleRepeat(reason: string) {
    const request = repeat;
    if (!request) return;
    clearTimeout(request.timer);
    repeat = null;
    logVital(request.capture, request.kind, lastClear(request.candidates), "unconfirmed", request.candidates);
    diagnostic("vital.unconfirmed", { session: request.capture.id, kind: request.kind, reason });
  }

  function nextRepeat() {
    const request = repeatQueue.shift();
    if (!request || request.capture !== state.capture) return;
    repeat = request;
    void prompt(request);
  }

  // Stop ends any open question: what was never repeated stays unconfirmed for the ER.
  function endRepeats() {
    settleRepeat("capture stopped");
    for (const request of repeatQueue.splice(0)) {
      repeat = request;
      settleRepeat("capture stopped");
    }
  }

  function note(capture: Capture, text: string) {
    const seq = ++capture.noteSeq;
    enqueue({
      capture, path: `/api/sessions/${capture.id}/notes`, label: `note ${seq}`, contentType: "application/json",
      body: JSON.stringify({ seq, seconds: elapsed(capture), text: text.slice(0, 2000) }),
    });
  }

  // After a capture the ER can ask the medic about it. The glasses read each message aloud
  // between captures, never into a recording, and the medic's spoken answer is the reply.
  // Nothing is stored: closing Inbound ends the conversation, and its record stays with the ER.
  function converse(capture: Capture) {
    talk = capture;
    state.conversation = { session: capture.id, current: null, listening: false, draft: "", photo: "none", sent: false };
  }

  async function checkMessages() {
    const capture = talk;
    if (!capture || state.capture || checkingMessages || Date.now() - lastMessageCheck < MESSAGE_POLL_MS) return;
    // The capture has to reach the Mac before anyone can write about it.
    if (outbox.some(job => job.capture.id === capture.id && job.label === "session")) return;
    lastMessageCheck = Date.now();
    checkingMessages = true;
    try {
      const { messages } = await request<{ messages: ChatMessage[] }>(capture.server, `/api/sessions/${capture.id}/messages`);
      if (talk !== capture || !Array.isArray(messages)) return;
      for (const message of messages) {
        if (message.from !== "er" || message.heard_at || announced.has(message.id)) continue;
        announced.add(message.id);
        void announce(capture, message);
      }
    } catch {
      // Checked again shortly.
    } finally {
      checkingMessages = false;
    }
  }

  async function announce(capture: Capture, message: ChatMessage) {
    diagnostic("message.received", { session: capture.id });
    state.conversation = state.conversation && { ...state.conversation, current: message, listening: false, draft: "", photo: "none", sent: false };
    state.message = "Message from the ER. Listen on the glasses.";
    publish();
    // "Go ahead": radio for "your turn". Whatever the medic says next is the reply.
    const spoke = await say(`Message from the E.R.: ${message.text} … Go ahead.`);
    if (talk !== capture || state.capture) return;
    if (!spoke) {
      state.error = "The glasses could not read the ER’s message aloud. It is shown below.";
      publish();
      return;
    }
    enqueue({ capture, path: `/api/sessions/${capture.id}/messages/${message.id}/heard`, label: "message heard", contentType: "application/json", body: "{}" });
    listen(capture, message);
  }

  function listen(capture: Capture, message: ChatMessage) {
    if (replying) void sendReply();
    const reply: Reply = { capture, id: crypto.randomUUID(), to: message.id, question: message.text, parts: [] };
    replying = reply;
    reply.wait = setTimeout(() => {
      if (replying !== reply || reply.parts.length || reply.photo) return;
      replying = null;
      state.conversation = state.conversation && { ...state.conversation, listening: false };
      state.message = "No reply heard. Tap Reply to answer the ER.";
      publish();
    }, ANSWER_WAIT_MS);
    state.conversation = state.conversation && { ...state.conversation, listening: true, draft: "", photo: "none" };
    state.message = "Say your reply to the ER. Say “snap” to add a photo.";
    publish();
  }

  // A pause ends the reply. The medic still talking, or a photo still coming, holds it open.
  function settleReply(reply: Reply, ms = ANSWER_SETTLE_MS) {
    clearTimeout(reply.settle);
    reply.settle = setTimeout(() => { if (replying === reply) void sendReply(); }, ms);
  }

  function hearReply(reply: Reply, text: string, final: boolean) {
    clearTimeout(reply.wait);
    // A sentence that starts a new capture is a command, not an answer.
    if (final && !findCommands(speechWords(text)).some(hit => hit.command === "start")) {
      // Command words steer the reply; the ER doesn't need them in its text.
      const said = text.replace(/\b(?:snap(?:shot)?|screen ?shot|stop)\b[.,!?]?/gi, " ").replace(/\s+/g, " ").trim();
      if (said) reply.parts.push(said);
      state.conversation = state.conversation && { ...state.conversation, draft: reply.parts.join(" ") };
    }
    // A final result follows a partial, so wait longer after one.
    if (!reply.photo || final) settleReply(reply, final ? ANSWER_SETTLE_MS : ANSWER_SETTLE_MS * 2);
  }

  function replyPhoto(reply: Reply) {
    if (reply.photo) return;
    clearTimeout(reply.wait);
    clearTimeout(reply.settle);
    state.conversation = state.conversation && { ...state.conversation, photo: "taking" };
    state.message = "Taking a photo for the ER…";
    publish();
    reply.photo = (async () => {
      try {
        const shot = await grabPhoto({ session: reply.capture.id, number: 0 }, () => {}, lastPhoto);
        enqueue({ capture: reply.capture, label: "reply photo", path: `/api/sessions/${reply.capture.id}/replies/${reply.id}/photo`, ...photoBody(shot) });
        diagnostic("message.photo", { session: reply.capture.id, transfer: shot.local ? "bluetooth" : "wifi" });
        state.conversation = state.conversation && { ...state.conversation, photo: "attached" };
        return true;
      } catch (error) {
        state.conversation = state.conversation && { ...state.conversation, photo: "failed" };
        problem(error, "reply photo");
        return false;
      } finally {
        publish();
        // Words said while the photo was taken belong to the reply; send after the next pause.
        if (replying === reply) settleReply(reply);
      }
    })();
  }

  async function sendReply() {
    const reply = replying;
    if (!reply) return;
    clearTimeout(reply.wait);
    clearTimeout(reply.settle);
    replying = null;
    const heard = reply.parts.join(" ");
    const text = withoutEcho(heard, reply.question);
    state.conversation = state.conversation && { ...state.conversation, listening: false, draft: text };
    if (!text && !reply.photo) {
      state.message = "No reply heard. Tap Reply to answer the ER.";
      publish();
      return;
    }
    // Vitals in the answer update the patient. The last value given for each counts.
    // An unlikely but clear number counts too: the read-back lets the medic catch a mishearing.
    const readings = findVitals(text, expectedVital(reply.question)).map(reading => ({ kind: reading.kind, value: reading.value || reading.heard || "" })).filter(reading => reading.value);
    const vitals = [...new Map(readings.map(reading => [reading.kind, reading.value])).entries()].map(([kind, value]) => ({ kind, value }));
    enqueue({
      capture: reply.capture, path: `/api/sessions/${reply.capture.id}/replies`, label: "reply", contentType: "application/json",
      body: JSON.stringify({ id: reply.id, text, heard, reply_to: reply.to, vitals }),
    });
    for (const { kind, value } of vitals) state.vitals = [...state.vitals.filter(vital => vital.kind !== kind), { kind, value, status: "updated" }];
    state.message = "Reply sent to the ER.";
    publish();
    const photo = await reply.photo;
    diagnostic("message.replied", { session: reply.capture.id, photo: !!photo, vitals: vitals.length });
    // Read the vitals back, so the medic catches a mishearing and can answer again.
    const logged = vitals.map(({ kind, value }) => `${vitalNames[kind]} ${spokenValue(kind, value)}`).join(", ");
    state.conversation = state.conversation && { ...state.conversation, sent: true };
    publish();
    await say(logged ? `${logged[0].toUpperCase()}${logged.slice(1)}, logged.${photo ? " Photo sent." : ""}`
      : photo ? "Reply sent with the photo." : "Reply sent.");
    // Answered: the phone lets the message go. The thread stays on the ER's dashboard.
    if (state.conversation?.current?.id === reply.to && !replying) {
      state.conversation = { ...state.conversation, current: null, sent: false, draft: "", photo: "none" };
      publish();
    }
  }

  // The glasses' microphone hears them read the question, and the recognizer can join that
  // to the medic's answer. They always end with "Go ahead", so what comes before it is theirs.
  // Without it, a start that repeats the question's words is theirs too.
  function withoutEcho(heard: string, question: string) {
    const words = heard.split(/\s+/).filter(Boolean);
    const plain = words.map(word => speechWords(word).join(" "));
    const ahead = plain.findIndex((word, index) => word === "go" && plain[index + 1] === "ahead");
    if (ahead >= 0) return words.slice(ahead + 2).join(" ");
    const asked = new Set(speechWords(`message from the e r er ${question}`));
    let start = 0;
    while (start < plain.length && asked.has(plain[start])) start++;
    return start >= 2 ? words.slice(start).join(" ") : heard;
  }

  // A question about one vital makes a bare number its answer: "one ten" to "What is the heart rate now?"
  const asksAbout: [VitalKind, RegExp][] = [
    ["bp", /blood pressure|\bbp\b/i], ["hr", /heart rate|pulse/i], ["spo2", /oxygen|saturation|\bsats\b|spo2|spo₂/i], ["rr", /resp|breathing/i],
  ];
  function expectedVital(question: string): VitalKind | undefined {
    const kinds = asksAbout.filter(([, pattern]) => pattern.test(question));
    return kinds.length === 1 ? kinds[0][0] : undefined;
  }

  // The ER's message on screen, to read again or answer from the phone.
  const latestQuestion = () => state.conversation?.current ?? undefined;

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
    // While the medic answers the ER, "snap" adds a photo to the reply and "stop" sends it.
    const answering = !state.capture ? replying : null;
    if (command === "start") {
      if (state.capture) return feedback("Heard “start”. Already recording.");
      if (checking) return feedback("Heard “start”. Wait for the video upload test to finish.");
      if (answering) void sendReply();
      start();
    } else if (command === "snap") {
      if (answering) replyPhoto(answering);
      else if (!state.capture) return feedback("Heard “snap”. Say “start” first.");
      else snap();
    } else if (answering) void sendReply();
    else {
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
    // Between captures, what the medic says after an ER message is the reply. Its words go in
    // before commands run, so a "stop" at the end sends them too.
    const reply = !capture && replying && Date.now() >= speakingUntil ? replying : null;
    if (reply && data.isFinal) hearReply(reply, text, true);
    scan(data.isFinal);
    if (reply && !data.isFinal && replying === reply) hearReply(reply, text, false);
    if (data.isFinal) {
      // The sentence that said "start" or "stop" belongs to that capture too.
      const target = capture ?? state.capture;
      if (target) {
        note(target, text);
        heardVitals(target, text);
      }
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
  session.ui.on("checkUpload", () => { void run(checkVideoUpload); });
  session.ui.on("readAgain", () => {
    const capture = talk;
    const message = latestQuestion();
    if (capture && message && !state.capture && !replying) void announce(capture, message);
  });
  session.ui.on("reply", () => {
    const capture = talk;
    const message = latestQuestion();
    if (!capture || !message || state.capture || replying) return;
    void say("Go ahead.").then(() => { if (talk === capture && !state.capture) listen(capture, message); });
  });
  session.ui.on("checkSpeaker", () => { void run(async () => {
    state.message = "Speaking through the glasses…";
    publish();
    const spoke = await say("This is Inbound. If you can hear me on the glasses, read-backs will work.");
    state.message = spoke ? "Played. If it came from the phone instead of the glasses, make the glasses your phone's audio output."
      : "The phone could not play speech. Check Mentra's voice settings and the phone's volume.";
  }); });
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
    state.glassesIp = data.connected ? data.localIp ?? "" : "";
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
    // A conversation with the ER never outlives the MiniApp. An earlier build kept its capture.
    void session.storage.delete("talk").catch(() => {});
    const journal = await session.storage.get("capture");
    if (journal) {
      // The MiniApp closed mid-capture. Queued uploads were lost with it; ask
      // the Mac to build the report from what already arrived.
      const capture = JSON.parse(journal) as Capture;
      state.delivered = { id: capture.id, server: capture.server, status: "uploading", progress: "Finishing the previous capture…" };
      converse(capture);
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
    void checkMessages();
  }, 1000);
  session.on("disconnect", () => {
    closed = true;
    streamAudio(false);
    resetSpeech();
    clearTimeout(warmTimer);
    clearTimeout(videoLimit);
    clearTimeout(replying?.wait);
    clearTimeout(replying?.settle);
    clearInterval(ticker);
  });
});
