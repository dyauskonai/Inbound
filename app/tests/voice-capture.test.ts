import { afterEach, expect, test } from "bun:test";
import { MiniappRequestType as Request, MiniappResponseType as ResponseType } from "@mentra/miniapp/background";
import type { State } from "../src/shared/channels";
import { commandFrom, findCommands, speechWords } from "../src/shared/commands";

const SERVER = "http://192.0.2.1:8000";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const host = globalThis as typeof globalThis & {
  INBOUND_SERVER: string;
  INBOUND_LOCAL_SERVER: string;
  INBOUND_TOKEN: string;
  __dispatch: (module: string, method: string, args: string) => void;
  __mentraInitCallback: (id: string) => void;
  __mentraDeliverBridgeRaw: (message: string) => void;
  __mentraBackgroundSession?: { disconnect: () => void };
};
host.INBOUND_SERVER = SERVER;
host.INBOUND_LOCAL_SERVER = SERVER;
host.INBOUND_TOKEN = "";
await import("../src/background/index");

const originalFetch = globalThis.fetch;
afterEach(() => {
  host.__mentraBackgroundSession?.disconnect();
  globalThis.fetch = originalFetch;
});

interface Call { method: string; path: string; body: unknown; auth?: string }

async function connect({ journal = null as string | null, video = false, failVideoStart = false, alreadyRecording = 0, staleRecording = "" } = {}) {
  let state!: State;
  let tick: (() => void) | undefined;
  let offline = 0;
  let refuseToken = false;
  let holdPhotos = false;
  let busyNext = 0;
  const heldPhotos: (() => void)[] = [];
  let macStatus = "processing";
  let photoReply: object | null = { photoUrl: "https://photos.example/1.jpg", mimeType: "image/jpeg" };
  const rejected = new Map<string, number>();
  const calls: Call[] = [];
  const requests: { type: string; [key: string]: unknown }[] = [];
  const storage = new Map<string, string>([
    ["video", video ? "on" : "off"],
    ...(journal ? [["capture", journal] as [string, string]] : []),
    ...(staleRecording ? [["videoRecording", staleRecording] as [string, string]] : []),
  ]);
  let cloudDown = 0;
  let uploadUnreachable = false;
  let tunnelUrl: string | null = null;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: () => void, interval: number) => {
    if (interval === 1000) tick = callback;
    return originalSetInterval(() => {}, 60_000);
  }) as typeof setInterval;

  const deliver = (payload: object, requestId?: string) => host.__mentraDeliverBridgeRaw(JSON.stringify({ payload, requestId }));
  const event = (streamType: string, data: object, transcriptionRoute?: "forceLocal") =>
    deliver({ type: ResponseType.EVENT, streamType, data, transcriptionRoute });

  host.__dispatch = (_module, _method, args) => {
    const [raw] = JSON.parse(args);
    const { payload, requestId } = JSON.parse(raw);
    requests.push(payload);
    const reply = (data?: unknown, error?: object) =>
      queueMicrotask(() => deliver({ type: ResponseType.REQUEST_RESULT, ok: !error, data, error }, requestId));
    switch (payload.type) {
      case Request.CONNECT:
        queueMicrotask(() => deliver({ type: ResponseType.CONNECT_ACK, capabilities: { hasCamera: true }, hostFeatures: { initReady: true } }));
        break;
      case Request.READY:
        queueMicrotask(() => {
          event("glasses_connection", { connected: true });
          event("transcription_model_status", { language: "en-US", state: "ready" });
          event("_ui", { type: "UI_OPEN" });
        });
        break;
      case Request.STORAGE_GET:
        reply({ value: storage.get(payload.key) ?? null });
        break;
      case Request.STORAGE_SET:
        storage.set(payload.key, payload.value);
        reply();
        break;
      case Request.STORAGE_DELETE:
        storage.delete(payload.key);
        reply();
        break;
      case Request.PHOTO: {
        const answer = () => photoReply ? reply(photoReply) : reply(undefined, { code: "camera_busy", message: "Camera is busy" });
        if (cloudDown > 0 && payload.delivery !== "local") {
          cloudDown--;
          reply(undefined, { code: "PHOTO_REQUEST_FAILED", message: "Could not reach Mentra cloud" });
        } else if (busyNext > 0) {
          busyNext--;
          reply(undefined, { code: "camera_busy", message: "Camera is busy" });
        } else if (holdPhotos) heldPhotos.push(answer);
        else answer();
        break;
      }
      case Request.VIDEO_RECORDING_STOP:
        if (uploadUnreachable && payload.uploadUrl) reply(undefined, { code: "ERR_UNEXPECTED", message: "Video upload error: failed to connect to /192.0.2.1 (port 8000) from /10.16.95.18 (port 38510) after 10000ms" });
        else reply();
        break;
      case Request.VIDEO_RECORDING_START:
        if (alreadyRecording > 0) {
          alreadyRecording--;
          reply(undefined, { code: "ALREADY_RECORDING", message: "A video recording is already in progress" });
        } else if (failVideoStart) reply(undefined, { code: "ERR_UNEXPECTED", message: "Start timed out waiting for glasses response." });
        else reply({ recordingId: "camera-1" });
        break;
      case Request.BLOB_OPEN_READ:
        reply({ handle: "photo-handle", meta: {} });
        break;
      case Request.BLOB_READ:
        reply({ base64: Buffer.from(PHOTO).toString("base64"), done: true });
        break;
      case "UI_SEND":
        if (payload.channel === "state") state = payload.payload;
        break;
      default:
        if (requestId) reply();
    }
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://photos.example/")) return new Response(PHOTO);
    const path = url.slice(SERVER.length);
    const method = init?.method ?? "GET";
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (offline > 0 && method === "POST") {
      offline--;
      throw new TypeError("Network request failed");
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ method, path, body, auth });
    if (refuseToken) return Response.json({ detail: "Sign in to Inbound." }, { status: 401 });
    const status = rejected.get(path.replace(/\?.*$/, "").split("/").at(-1)!);
    if (status) return Response.json({ detail: "Refused" }, { status });
    if (path === "/api/health") return Response.json({ ok: true, ai_configured: true, video_upload_url: tunnelUrl });
    if (path === "/api/sessions") return Response.json({ id: (body as { id: string }).id }, { status: 201 });
    if (method === "GET") return Response.json({ status: macStatus, progress: "Transcribing 0–30 seconds" });
    return Response.json({ ok: true });
  }) as typeof fetch;

  host.__mentraInitCallback("test");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  globalThis.setInterval = originalSetInterval;
  const settle = async (ms = 0) => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  await settle();
  return {
    get state() { return state; },
    calls, requests, storage, settle,
    posts: () => calls.filter(call => call.method === "POST" && !call.path.endsWith("/video-state"))
      .map(call => call.path.replace(/^\/api\/sessions\/[^/]+/, "").replace(/\?.*$/, "") || "/api/sessions"),
    videoStates: () => calls.filter(call => call.path.endsWith("/video-state")).map(call => (call.body as { state: string }).state),
    voice: (text: string, isFinal = true) => event("transcription:en-US", { text, isFinal, source: "local" }, "forceLocal"),
    audio: (data: string, sampleRate = 16000) => event("audio_chunk", { data, sampleRate, format: "pcm16" }),
    button: (command: string) => event("_ui", { type: "UI_MESSAGE", channel: "command", payload: { command } }),
    tick: () => tick?.(),
    goOffline: (requests: number) => { offline = requests; },
    refuseToken: (value: boolean) => { refuseToken = value; },
    // Photos that take a while to capture and transfer.
    holdPhotos: () => { holdPhotos = true; },
    releasePhoto: () => heldPhotos.shift()?.(),
    busyNextPhoto: () => { busyNext++; },
    glassesWifi: (connected: boolean) => event("glasses_wifi", { connected }),
    cloudDown: () => { cloudDown++; },
    glassesCannotReachServer: () => { uploadUnreachable = true; },
    serverTunnel: (url: string) => { tunnelUrl = url; },
    toggleVideo: (enabled: boolean) => event("_ui", { type: "UI_MESSAGE", channel: "video", payload: { enabled } }),
    reject: (endpoint: string, status: number) => rejected.set(endpoint, status),
    photoReply: (value: object | null) => { photoReply = value; },
    macStatus: (value: string) => { macStatus = value; },
  };
}

test("command words are found anywhere in a sentence", () => {
  expect(commandFrom("Okay, start the handoff now.")).toBe("start");
  expect(commandFrom("Please take a screenshot of the wound")).toBe("snap");
  expect(commandFrom("That's everything, stop.")).toBe("stop");
  expect(commandFrom("don't stop compressions")).toBeNull();
  expect(commandFrom("the patient started shaking")).toBeNull();
  expect(findCommands(speechWords("snap the arm then snap the leg and stop")).map(hit => `${hit.command}${hit.occurrence}`))
    .toEqual(["snap1", "snap2", "stop1"]);
});

test("start inside a sentence begins recording from a partial result, with no network wait", async () => {
  const app = await connect();
  app.voice("okay start the handoff", false);
  expect(app.state.phase).toBe("recording");
  expect(app.state.voiceCommand).toBe("Voice command accepted: start");
  await app.settle();
  const create = app.calls.find(call => call.path === "/api/sessions")!;
  expect((create.body as { id: string }).id).toBe(app.state.capture!.id);
  // Later partials and the final repeat the same word; it fires once.
  app.voice("okay start the handoff patient is", false);
  app.voice("okay start the handoff patient is 45", true);
  await app.settle();
  expect(app.state.phase).toBe("recording");
  expect(app.calls.filter(call => call.path === "/api/sessions")).toHaveLength(1);
});

test("a command word at the end of a partial waits briefly in case the word grows", async () => {
  const app = await connect();
  app.voice("the patient start", false);
  expect(app.state.phase).toBe("ready");
  app.voice("the patient started", false);
  await app.settle(400);
  expect(app.state.phase).toBe("ready");
  app.voice("now start", false);
  await app.settle(400);
  expect(app.state.phase).toBe("recording");
});

test("snap takes a photo and uploads it to the Mac; stop sends audio, transcript, and finish in order", async () => {
  const app = await connect();
  app.button("start");
  await app.settle();
  const id = app.state.capture!.id;
  app.audio(Buffer.alloc(3200).toString("base64"));
  app.audio(Buffer.alloc(3200).toString("base64"));
  app.voice("bp is 190 over 90 snap the left forearm", false);
  await app.settle();
  const photo = app.requests.find(request => request.type === Request.PHOTO)!;
  expect(photo.delivery).toBe("local");
  expect(app.state.capture!.photos[0].status).toBe("saved");
  const upload = app.calls.find(call => call.path.startsWith(`/api/sessions/${id}/photos`))!;
  expect(upload.path).toContain("seq=1");
  expect([...(upload.body as Uint8Array)]).toEqual([...PHOTO]);
  app.voice("bp is 190 over 90 snap the left forearm", true);
  app.voice("that's all, stop", true);
  expect(app.state.phase).toBe("ready");
  await app.settle();
  expect(app.posts()).toEqual(["/api/sessions", "/photos", "/notes", "/audio", "/notes", "/finish"]);
  const audio = app.calls.find(call => call.path.endsWith("/audio"))!.body as { seq: number; chunks: string[]; sample_rate: number };
  expect(audio.seq).toBe(1);
  expect(audio.chunks).toHaveLength(2);
  expect(audio.sample_rate).toBe(16000);
  const finish = app.calls.find(call => call.path.endsWith("/finish"))!.body as { audio_parts: number; photos: number; notes: number };
  expect(finish).toMatchObject({ audio_parts: 1, photos: 1, notes: 2 });
  expect(app.storage.has("capture")).toBe(false);
});

test("two snaps in one sentence take two photos, and finish waits for the last photo", async () => {
  const app = await connect();
  app.button("start");
  app.voice("snap the arm then snap the leg and stop", true);
  await app.settle();
  expect(app.requests.filter(request => request.type === Request.PHOTO)).toHaveLength(2);
  expect(app.posts()).toEqual(["/api/sessions", "/notes", "/photos", "/photos", "/finish"]);
});

test("photos are read from the phone when the host keeps them local", async () => {
  const app = await connect();
  app.photoReply({ key: "photo/123", mimeType: "image/jpeg", url: "/.mentra/files/123.jpg" });
  app.button("start");
  app.button("snap");
  await app.settle();
  const upload = app.calls.find(call => call.path.includes("/photos"))!;
  expect([...(upload.body as Uint8Array)]).toEqual([...PHOTO]);
  expect(app.requests.some(request => request.type === Request.BLOB_DELETE && request.key === "photo/123")).toBe(true);
});

test("a failed photo is reported and leaves the recording running", async () => {
  const app = await connect();
  app.photoReply(null);
  app.button("start");
  app.voice("snap", true);
  await app.settle();
  expect(app.state.phase).toBe("recording");
  expect(app.state.capture!.photos[0].status).toBe("failed");
  expect(app.state.error).toBe("Camera is busy");
});

test("uploads wait and retry while the Mac is unreachable, then arrive in order", async () => {
  const app = await connect();
  app.goOffline(2);
  app.button("start");
  app.voice("first line", true);
  await app.settle();
  expect(app.state.phase).toBe("recording");
  expect(app.state.pending).toBe(2);
  expect(app.state.error).toContain("Waiting for the server");
  await app.settle(1100);
  expect(app.state.pending).toBe(2);
  await app.settle(2100);
  expect(app.state.pending).toBe(0);
  expect(app.state.error).toBe("");
  expect(app.posts()).toEqual(["/api/sessions", "/notes"]);
});

test("a request the Mac refuses is dropped so later uploads continue", async () => {
  const app = await connect();
  app.reject("audio", 415);
  app.button("start");
  app.audio(Buffer.alloc(320).toString("base64"));
  app.button("stop");
  await app.settle();
  expect(app.posts()).toEqual(["/api/sessions", "/audio", "/finish"]);
  expect(app.state.pending).toBe(0);
  expect(app.state.diagnostics.some(line => line.includes("upload.rejected"))).toBe(true);
});

test("negated, repeated, and out-of-place commands are ignored", async () => {
  const app = await connect();
  app.voice("stop", true);
  expect(app.state.voiceCommand).toBe("Heard “stop”. Nothing is recording.");
  app.voice("snap", true);
  expect(app.state.voiceCommand).toBe("Heard “snap”. Say “start” first.");
  app.voice("start", true);
  // The recognizer restarts the utterance and repeats the word.
  app.voice("start", false);
  app.voice("start now", false);
  await app.settle();
  expect(app.calls.filter(call => call.path === "/api/sessions")).toHaveLength(1);
  app.voice("don't stop compressions", true);
  expect(app.state.phase).toBe("recording");
});

test("the phone follows the Mac's report status after finishing", async () => {
  const app = await connect();
  app.button("start");
  app.button("snap");
  app.button("stop");
  await app.settle();
  expect(app.state.delivered?.status).toBe("processing");
  app.macStatus("complete");
  app.tick();
  await app.settle();
  expect(app.state.delivered?.status).toBe("complete");
  expect(app.state.delivered?.progress).toBe("Report ready on the Mac dashboard.");
});

test("a capture interrupted by a MiniApp restart is finished on the next launch", async () => {
  const journal = JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", server: SERVER, startedAt: Date.now() - 5000, audioSeq: 3, noteSeq: 1, photos: [] });
  const app = await connect({ journal });
  await app.settle();
  const finish = app.calls.find(call => call.path.endsWith("/finish"))!;
  expect(finish.path).toBe("/api/sessions/11111111-2222-4333-8444-555555555555/finish");
  expect(app.storage.has("capture")).toBe(false);
});

test("the build's access token is sent, and a refused token keeps uploads queued", async () => {
  host.INBOUND_TOKEN = "device-secret";
  try {
    const app = await connect();
    app.refuseToken(true);
    app.button("start");
    app.voice("patient is stable", true);
    await app.settle();
    expect(app.calls.at(-1)!.auth).toBe("Bearer device-secret");
    expect(app.state.pending).toBe(2);
    expect(app.state.error).toContain("refused this phone");
    app.refuseToken(false);
    await app.settle(1100);
    expect(app.state.pending).toBe(0);
    expect(app.posts().slice(-2)).toEqual(["/api/sessions", "/notes"]);
  } finally {
    host.INBOUND_TOKEN = "";
  }
});

test("raw audio streams only between start and stop", async () => {
  const app = await connect();
  // Plain streams are listed by name; transcription entries are objects.
  const subscribed = () => ((app.requests.filter(request => request.type === Request.SUBSCRIBE).at(-1)?.subscriptions ?? []) as unknown[])
    .includes("audio_chunk");
  expect(subscribed()).toBe(false);
  app.button("start");
  await app.settle();
  expect(subscribed()).toBe(true);
  app.button("stop");
  await app.settle();
  expect(subscribed()).toBe(false);
  // Voice commands keep listening for the next "start".
  app.voice("okay start again", true);
  expect(app.state.phase).toBe("recording");
  expect(subscribed()).toBe(true);
});

test("start also records video, and stop asks the glasses to upload it to the session", async () => {
  const app = await connect({ video: true });
  app.voice("okay start the handoff", false);
  await app.settle();
  const id = app.state.capture!.id;
  const start = app.requests.find(request => request.type === Request.VIDEO_RECORDING_START)!;
  expect(start).toMatchObject({ save: true, width: 1280, height: 720 });
  expect(app.state.capture!.video).toMatchObject({ state: "recording", recordingId: "camera-1" });
  app.voice("okay start the handoff and stop", true);
  await app.settle();
  const stop = app.requests.find(request => request.type === Request.VIDEO_RECORDING_STOP)!;
  expect(stop).toMatchObject({ recordingId: "camera-1", uploadUrl: `${SERVER}/api/sessions/${id}/video` });
  expect(app.videoStates()).toEqual(["recording", "uploading"]);
  expect(app.posts().at(-1)).toBe("/finish");
});

test("during video a snap is marked instantly, and its still comes from the video", async () => {
  const app = await connect({ video: true });
  app.button("start");
  app.voice("snap the left forearm", true);
  await app.settle();
  // The glasses refuse photos while recording, so Inbound doesn't ask.
  expect(app.requests.some(request => request.type === Request.PHOTO)).toBe(false);
  expect(app.requests.some(request => request.type === Request.CAMERA_WARM_UP)).toBe(false);
  expect(app.state.capture!.photos[0].status).toBe("from_video");
  expect(app.state.error).toBe("");
  const seconds = app.state.capture!.photos[0].seconds;
  app.button("stop");
  await app.settle();
  const finish = app.calls.find(call => call.path.endsWith("/finish"))!.body as { video_frames: unknown[]; photos: number };
  expect(finish.video_frames).toEqual([{ seq: 1, seconds }]);
  expect(finish.photos).toBe(1);
});

test("audio and photos keep recording when the glasses can't start video, and video can be turned off", async () => {
  const app = await connect({ video: true, failVideoStart: true });
  app.button("start");
  app.button("snap");
  await app.settle();
  expect(app.state.phase).toBe("recording");
  expect(app.state.capture!.video?.state).toBe("failed");
  expect(app.state.capture!.photos[0].status).toBe("saved");
  expect(app.videoStates()).toEqual(["failed"]);
  app.button("stop");
  await app.settle();
  expect(app.requests.some(request => request.type === Request.VIDEO_RECORDING_STOP)).toBe(false);
  app.toggleVideo(false);
  app.button("start");
  await app.settle();
  expect(app.requests.filter(request => request.type === Request.VIDEO_RECORDING_START)).toHaveLength(1);
  expect(app.storage.get("video")).toBe("off");
});

test("without video, the camera stays warm and each snap fires without waiting for the last photo", async () => {
  const app = await connect();
  app.holdPhotos();
  app.button("start");
  await app.settle();
  expect(app.requests.find(request => request.type === Request.CAMERA_WARM_UP)).toMatchObject({ size: "medium", mode: "photo" });
  app.voice("snap the arm then snap the leg", true);
  await app.settle();
  // Both shutters fired while the first photo was still transferring.
  expect(app.requests.filter(request => request.type === Request.PHOTO)).toHaveLength(2);
  app.button("stop");
  await app.settle();
  expect(app.posts()).not.toContain("/finish");
  app.releasePhoto();
  app.releasePhoto();
  await app.settle();
  expect(app.state.delivered).not.toBeNull();
  expect(app.posts().slice(-3)).toEqual(["/photos", "/photos", "/finish"]);
});

test("a snap the camera is too busy for is retried once the previous photo is done", async () => {
  const app = await connect();
  app.holdPhotos();
  app.button("start");
  app.button("snap");
  await app.settle();
  app.busyNextPhoto();
  app.button("snap");
  await app.settle();
  expect(app.requests.filter(request => request.type === Request.PHOTO)).toHaveLength(2);
  app.releasePhoto();
  await app.settle();
  // The retry went out after the first photo finished.
  expect(app.requests.filter(request => request.type === Request.PHOTO)).toHaveLength(3);
  app.releasePhoto();
  await app.settle();
  expect(app.state.capture!.photos.map(photo => photo.status)).toEqual(["saved", "saved"]);
  expect(app.state.error).toBe("");
});

test("with glasses Wi-Fi, photos skip the slow Bluetooth-only path, falling back if Mentra's cloud is unreachable", async () => {
  const app = await connect();
  app.glassesWifi(true);
  app.button("start");
  app.button("snap");
  await app.settle();
  const first = app.requests.filter(request => request.type === Request.PHOTO);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ transferMethod: "auto", compress: "medium" });
  expect(first[0].delivery).toBeUndefined();
  app.cloudDown();
  app.button("snap");
  await app.settle();
  const photos = app.requests.filter(request => request.type === Request.PHOTO);
  expect(photos.map(request => request.delivery)).toEqual([undefined, undefined, "local"]);
  expect(app.state.capture!.photos.map(photo => photo.status)).toEqual(["saved", "saved"]);
});

test("a video recording Mentra never released is stopped, and the new one starts", async () => {
  const app = await connect({ video: true, alreadyRecording: 1, staleRecording: "camera-old" });
  app.button("start");
  await app.settle();
  expect(app.requests.find(request => request.type === Request.VIDEO_RECORDING_STOP)).toMatchObject({ recordingId: "camera-old" });
  expect(app.state.capture!.video).toMatchObject({ state: "recording", recordingId: "camera-1" });
  expect(app.storage.get("videoRecording")).toBe("camera-1");
});

test("if Mentra still holds an old recording, the app says to reopen Mentra and photos still work", async () => {
  const app = await connect({ video: true, alreadyRecording: 2, staleRecording: "camera-old" });
  app.button("start");
  app.button("snap");
  await app.settle();
  expect(app.state.capture!.video?.state).toBe("failed");
  expect(app.state.capture!.video?.detail).toContain("Fully quit and reopen the Mentra app");
  expect(app.state.capture!.photos[0].status).toBe("saved");
});

test("when the glasses can't reach the server, the app says why and where the video is", async () => {
  const app = await connect({ video: true });
  app.glassesCannotReachServer();
  app.button("start");
  await app.settle();
  app.button("stop");
  await app.settle();
  expect(app.videoStates()).toEqual(["recording", "failed"]);
  const detail = app.calls.filter(call => call.path.endsWith("/video-state")).at(-1)!.body as { state: string; detail: string };
  expect(detail.state).toBe("failed");
  expect(detail.detail).toContain("The glasses (10.16.95.18) could not reach the server (192.0.2.1)");
  expect(detail.detail).toContain("attach it on the dashboard");
});

test("with the server's tunnel, the glasses upload the video over the internet with the capture's own key", async () => {
  const app = await connect({ video: true });
  app.serverTunnel("https://inbound-demo.trycloudflare.com");
  app.button("start");
  await app.settle();
  const create = app.calls.find(call => call.path === "/api/sessions")!.body as { id: string; upload_token: string };
  expect(create.upload_token).toMatch(/^[a-f0-9]{64}$/);
  app.button("stop");
  await app.settle();
  const stop = app.requests.find(request => request.type === Request.VIDEO_RECORDING_STOP)!;
  expect(stop.uploadUrl).toBe(`https://inbound-demo.trycloudflare.com/api/sessions/${create.id}/video`);
  expect(stop.uploadAuthToken).toBe(create.upload_token);
  // Everything else still goes to the server on the local network.
  expect(app.calls.every(call => !call.path.startsWith("https://"))).toBe(true);
});
