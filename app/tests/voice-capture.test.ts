import { afterEach, expect, mock, test } from "bun:test";
import { MiniappRequestType as Request, MiniappResponseType as ResponseType } from "@mentra/miniapp/background";
import type { State } from "../src/shared/channels";

const SERVER = "http://192.0.2.1:8000";
const host = globalThis as typeof globalThis & {
  INBOUND_SERVER: string;
  INBOUND_LOCAL_SERVER: string;
  INBOUND_LIVE_ONLY: boolean;
  __dispatch: (module: string, method: string, args: string) => void;
  __mentraInitCallback: (id: string) => void;
  __mentraDeliverBridgeRaw: (message: string) => void;
  __mentraBackgroundSession?: { disconnect: () => void };
};
host.INBOUND_SERVER = SERVER;
await import("../src/background/index");

afterEach(() => {
  host.__mentraBackgroundSession?.disconnect();
  mock.restore();
});

async function connect(savedAddress: string | null = null, live = false, buildAddress = SERVER, liveOnly = false) {
  host.INBOUND_SERVER = buildAddress;
  host.INBOUND_LOCAL_SERVER = buildAddress.startsWith("http://") ? buildAddress : "";
  host.INBOUND_LIVE_ONLY = liveOnly;
  let state: State;
  let finishPoll: (() => void) | undefined;
  let finishStart: (() => void) | undefined;
  let rejectStart: (() => void) | undefined;
  let finishText: string | null = null;
  let finishUnsupported = false;
  let failStop = false;
  let uploadStatus = "created";
  let liveState = "waiting";
  let streamStartError: {code: string; message: string} | undefined;
  let liveStartedAt: number | undefined;
  let releaseCreate: (() => void) | undefined;
  let holdCreate = false;
  let releaseCaptureSync: (() => void) | undefined;
  let holdCaptureSync = false;
  let sessionCount = 0;
  const requests: { type: string; recordingId?: string; uploadUrl?: string }[] = [];
  const savedMarks: string[][] = [];
  const processedMarks: string[][] = [];
  const storage = new Map<string, string>();
  if (live && buildAddress === SERVER) {
    storage.set("captureMode", "live");
    storage.set("autoUpload", "off");
  }
  // The app uses one interval to check for an upload. Run it on demand.
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: () => void, interval: number) => {
    if (interval === 1000) finishPoll = callback;
    return originalSetInterval(() => {}, 60_000);
  }) as typeof setInterval;

  function deliver(payload: object, requestId?: string) {
    host.__mentraDeliverBridgeRaw(JSON.stringify({ payload, requestId }));
  }
  function event(streamType: string, data: object, transcriptionRoute?: "forceLocal") {
    deliver({ type: ResponseType.EVENT, streamType, data, transcriptionRoute });
  }

  host.__dispatch = (_module, _method, args) => {
    const [raw] = JSON.parse(args);
    const { payload, requestId } = JSON.parse(raw);
    requests.push(payload);
    const reply = (data?: object | string, error?: object) =>
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
        reply({ value: payload.key === "server" ? savedAddress : storage.get(payload.key) ?? null });
        break;
      case Request.STORAGE_SET:
        storage.set(payload.key, payload.value);
        reply();
        break;
      case Request.VIDEO_RECORDING_START:
        finishStart = () => reply({ recordingId: `camera-${sessionCount}` });
        rejectStart = () => reply(undefined, { code: "ERR_UNEXPECTED", message: "Start timed out waiting for glasses response." });
        break;
      case Request.STORAGE_DELETE:
        storage.delete(payload.key);
        reply();
        break;
      case Request.VIDEO_RECORDING_STOP:
        if (failStop) {
          failStop = false;
          reply(undefined, { code: "BLE_SEND_FAILED", message: "Glasses disconnected" });
        } else reply();
        break;
      case Request.TRANSCRIPTION_FINISH:
        if (finishUnsupported) reply(undefined, { code: "NOT_IMPLEMENTED", message: "Missing finish support" });
        else {
          if (finishText) queueMicrotask(() => event("transcription:en-US", { text: finishText, isFinal: true, source: "local" }, "forceLocal"));
          if (finishText === null) reply();
          else reply(finishText);
        }
        break;
      case Request.MIC_SET_LOUDNESS_GATE_ENABLED:
      case Request.MIC_SET_VAD_ENABLED:
        reply();
        break;
      case Request.STREAM_START:
        if (streamStartError) reply(undefined, streamStartError);
        // Otherwise deliberately omit the glasses acknowledgment.
        break;
      case Request.STREAM_STOP:
        reply();
        break;
      case "UI_SEND":
        if (payload.channel === "state") state = payload.payload;
        break;
    }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (!url.startsWith(buildAddress)) throw new Error("Cannot reach the old address");
    if (url.endsWith("/api/health")) return Response.json({ ok: true, live_capture: live });
    if (url.endsWith("/api/sessions")) {
      if (holdCreate) await new Promise<void>((resolve) => { releaseCreate = resolve; });
      return Response.json({ id: `session-${++sessionCount}`, live_capture: live }, { status: 201 });
    }
    if (url.endsWith("/live/start")) return Response.json({ port: 1935, key: "capture-key" });
    if (url.endsWith("/live/stop")) {
      if (!liveStartedAt) return Response.json({ has_video: false });
      uploadStatus = "uploaded";
      return Response.json({ has_video: true, live_started_at: liveStartedAt });
    }
    if (url.endsWith("/capture")) {
      const marks = JSON.parse(String(init?.body)).bookmarks.map((book: { id: string }) => book.id);
      if (holdCaptureSync) {
        holdCaptureSync = false;
        await new Promise<void>((resolve) => { releaseCaptureSync = resolve; });
      }
      savedMarks.push(marks);
      return Response.json({});
    }
    if (url.endsWith("/process")) {
      processedMarks.push(savedMarks.at(-1) ?? []);
      uploadStatus = "awaiting_key";
      return Response.json({ status: "processing" });
    }
    return Response.json({ has_video: uploadStatus !== "created", status: uploadStatus, live_state: liveState, live_started_at: liveStartedAt });
  }) as typeof fetch;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  host.__mentraInitCallback("test");
  try {
    await settle();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  return {
    get state() { return state; },
    requests, savedMarks, processedMarks, settle,
    voice: (text: string, isFinal = true) => event("transcription:en-US", { text, isFinal, source: "local" }, "forceLocal"),
    activity: (status: boolean, silentForMs = 0) => event("vad", { status, silentForMs }),
    finishWith: (text: string | null) => { finishText = text; },
    omitFinishSupport: () => { finishUnsupported = true; },
    button: (command: string) => event("_ui", { type: "UI_MESSAGE", channel: "command", payload: { command } }),
    reset: () => event("_ui", { type: "UI_MESSAGE", channel: "resetUnconfirmedStart", payload: {} }),
    stoppedOnGlasses: () => event("_ui", { type: "UI_MESSAGE", channel: "confirmStoppedOnGlasses", payload: {} }),
    confirmStart: () => finishStart?.(),
    rejectStart: () => rejectStart?.(),
    failNextStop: () => { failStop = true; },
    holdNextSync: () => { holdCaptureSync = true; },
    releaseSync: () => releaseCaptureSync?.(),
    holdCreate: () => { holdCreate = true; },
    releaseCreate: () => releaseCreate?.(),
    upload: () => { uploadStatus = "uploaded"; },
    receiveLiveVideo: () => { liveStartedAt = Date.now() - 500; liveState = "recording"; },
    requireStreamingUpdate: () => {
      streamStartError = { code: "STREAM_FIRMWARE_UPDATE_REQUIRED", message: "Update your glasses to turn on video streaming." };
    },
    rejectStreamingRequest: () => {
      streamStartError = { code: "CAMERA_ERROR", message: "CAMERA_ERROR (3): submitRequestList:401: Camera 0: Got error Function not implemented (-38) after trying to set streaming request" };
    },
    poll: () => finishPoll?.(),
    close: () => { globalThis.fetch = originalFetch; },
  };
}

test("a fresh relay URL overrides an expired one and uses device recording on a live-enabled Mac", async () => {
  const token = "a".repeat(64);
  const stale = `https://expired.example/device/${token}`;
  const current = `https://current.example/device/${token}`;
  const app = await connect(stale, true, current);
  try {
    expect(app.state.server).toBe(current);
    expect(app.state.captureMode).toBe("device");
    expect(app.state.autoUpload).toBe(true);
    app.voice("start");
    await app.settle();
    expect(app.requests.some(({ type }) => type === Request.VIDEO_RECORDING_START)).toBe(true);
    expect(app.requests.some(({ type }) => type === Request.STREAM_START)).toBe(false);
    app.confirmStart();
    await app.settle();
    app.voice("stop");
    await app.settle();
    expect(app.requests.find(({ type }) => type === Request.VIDEO_RECORDING_STOP)?.uploadUrl)
      .toBe(`${current}/api/sessions/session-1/video`);
  } finally { app.close(); }
});

test("only finalized command phrases act, consecutive snaps persist, and a failed stop can be repeated", async () => {
  const app = await connect();
  try {
    expect(app.state.voice).toBe("Voice commands ready");
    app.activity(true);
    app.voice("Start", false);
    app.activity(false, 300);
    expect(app.requests.filter(({ type }) => type === Request.TRANSCRIPTION_FINISH)).toHaveLength(0);
    expect(app.state.phase).toBe("ready");
    app.voice("Start the next step");
    expect(app.state.phase).toBe("ready");

    app.holdNextSync();
    app.voice(" Inbound, START recording! ");
    await app.settle();
    app.confirmStart();
    await app.settle();
    expect(app.state.phase).toBe("recording");

    app.voice("Snap", false);
    expect(app.state.capture?.bookmarks).toHaveLength(0);
    app.voice("Snap.");
    await app.settle();
    app.voice("Snap!");
    await app.settle();
    expect(app.state.capture?.bookmarks).toHaveLength(2);
    expect(app.savedMarks).toEqual([]);
    app.voice("Stop", false);
    app.voice("Stop to check the equipment");
    expect(app.state.phase).toBe("recording");

    app.failNextStop();
    app.voice("Inbound stop recording");
    await app.settle();
    expect(app.requests.filter(({ type }) => type === Request.VIDEO_RECORDING_STOP)).toHaveLength(0);
    app.releaseSync();
    await app.settle();
    expect(app.state.phase).toBe("stopping");
    expect(app.state.error).toBe("Glasses disconnected");
    app.voice("Stop");
    await app.settle();
    expect(app.state.phase).toBe("waiting_upload");
    const stops = app.requests.filter(({ type }) => type === Request.VIDEO_RECORDING_STOP);
    expect(stops).toHaveLength(2);
    expect(stops[1]).toMatchObject({ recordingId: "camera-1", uploadUrl: `${SERVER}/api/sessions/session-1/video` });
    app.upload();
    app.poll();
    await app.settle();
    expect(app.processedMarks).toEqual([["mark-1", "mark-2"]]);
  } finally { app.close(); }
});

test("a saved live mode cannot revive unsupported streaming on a new install", async () => {
  const app = await connect(null, true);
  try {
    expect(app.state.captureMode).toBe("device");
    expect(app.state.autoUpload).toBe(true);
    app.voice("Start");
    await app.settle();
    expect(app.requests.filter(({ type }) => type === Request.VIDEO_RECORDING_START)).toHaveLength(1);
    expect(app.requests.filter(({ type }) => type === Request.STREAM_START)).toHaveLength(0);
    app.confirmStart();
    await app.settle();
    expect(app.state.phase).toBe("recording");
    app.voice("Stop");
    await app.settle();
    expect(app.requests.find(({ type }) => type === Request.VIDEO_RECORDING_STOP)?.uploadUrl)
      .toBe(`${SERVER}/api/sessions/session-1/video`);
  } finally { app.close(); }
});

test("iPhone silence finalizes a command and a stale local Mac address recovers before capture", async () => {
  const app = await connect("http://192.0.2.2:8000");
  try {
    app.finishWith("Start the recording.");
    app.voice("Start", false);
    app.activity(false, 300);
    await Bun.sleep(500);
    expect(app.state.phase).toBe("starting");
    expect(app.state.server).toBe(SERVER);
    app.confirmStart();
    await app.settle();
    expect(app.state.phase).toBe("recording");

    app.finishWith(null);
    app.activity(true);
    app.voice("Snap", false);
    app.activity(false, 300);
    await Bun.sleep(500);
    expect(app.state.capture?.bookmarks).toHaveLength(1);
    app.voice("Snap.");
    expect(app.state.capture?.bookmarks).toHaveLength(1);
    app.voice("Snap.");
    expect(app.state.capture?.bookmarks).toHaveLength(2);

    app.activity(true);
    app.voice("Stop", false);
    app.activity(false, 300);
    app.activity(true);
    app.voice("Stop to check the equipment");
    await Bun.sleep(500);
    expect(app.state.phase).toBe("recording");

    app.omitFinishSupport();
    app.activity(true);
    app.voice("Stop", false);
    app.activity(false, 300);
    await Bun.sleep(500);
    expect(app.state.phase).toBe("waiting_upload");
    expect(app.requests.filter(({ type }) => type === Request.VIDEO_RECORDING_STOP)).toHaveLength(1);
    expect(app.state.diagnostics.join("\n")).toContain("mac.using_current_address");
    expect(app.state.diagnostics.join("\n")).toContain("speech.command_after_pause");
    expect(app.state.diagnostics.join("\n")).not.toContain("Stop to check the equipment");
  } finally { app.close(); }
});

test("a revised interim triggers finalization with neither a silence event nor a final transcript", async () => {
  const app = await connect();
  try {
    app.finishWith("Start recording.");
    app.voice("Start", false);
    await Bun.sleep(100);
    app.voice("Start rec", false);
    await Bun.sleep(1450);
    expect(app.state.phase).toBe("starting");
    expect(app.requests.filter(({ type }) => type === Request.VIDEO_RECORDING_START)).toHaveLength(1);
    expect(app.state.diagnostics.join("\n")).toContain('"endpoint":"transcript_pause"');
    app.confirmStart();
    await app.settle();

    app.finishWith(null);
    app.voice("Snap", false);
    await Bun.sleep(1450);
    expect(app.state.capture?.bookmarks).toHaveLength(1);
    app.voice("Snap.");
    expect(app.state.capture?.bookmarks).toHaveLength(1);

    // A revised transcript must not fall back to its earlier command word.
    app.voice("Stop", false);
    app.voice("Stop for a second", false);
    await Bun.sleep(1450);
    expect(app.state.phase).toBe("recording");
    expect(app.requests.filter(({ type }) => type === Request.VIDEO_RECORDING_STOP)).toHaveLength(0);
  } finally { app.close(); }
}, 7500);

test("a camera timeout stays visible and can be reset once the glasses are idle", async () => {
  const app = await connect();
  try {
    app.voice("Start recording");
    await app.settle();
    app.rejectStart();
    await app.settle();
    expect(app.state.phase).toBe("start_unconfirmed");
    expect(app.state.capture?.recordingId).toBeUndefined();
    expect(app.state.diagnostics.join("\n")).toContain("camera.start_unconfirmed");
    app.reset();
    await app.settle();
    app.voice("Start");
    await app.settle();
    app.confirmStart();
    await app.settle();
    expect(app.state.phase).toBe("recording");
  } finally { app.close(); }
});

test("stop before the start is sent cancels the camera request", async () => {
  const app = await connect();
  try {
    app.holdCreate();
    app.voice("Start");
    await app.settle();
    app.button("stop");
    expect(app.state.stopPending).toBe(true);
    app.releaseCreate();
    await app.settle();
    expect(app.state.phase).toBe("ready");
    expect(app.requests.some(({ type }) => type === Request.VIDEO_RECORDING_START)).toBe(false);
  } finally { app.close(); }
});

test("queued stop after a Start timeout keeps the session available for a saved clip", async () => {
  const app = await connect();
  try {
    app.omitFinishSupport();
    app.voice("Start", false);
    app.activity(false, 750);
    await app.settle();
    expect(app.state.phase).toBe("starting");
    expect(app.requests.find(({ type }) => type === Request.VIDEO_RECORDING_START)).toMatchObject({ width: 1280, height: 720, fps: 30, sound: false, save: true });
    app.voice("Stop", false);
    app.activity(false, 750);
    await app.settle();
    expect(app.state.stopPending).toBe(true);
    expect(app.requests.filter(({ type }) => type === Request.TRANSCRIPTION_FINISH)).toHaveLength(1);
    app.rejectStart();
    await app.settle();
    expect(app.state.phase).toBe("start_unconfirmed");
    expect(app.state.stopPending).toBe(false);
    expect(app.state.voiceCommand).toContain("Stop could not be sent");
    expect(app.state.diagnostics.join("\n")).toContain("command.queue_blocked");
    expect(app.requests.some(({ type }) => type === Request.VIDEO_RECORDING_STOP)).toBe(false);
    app.stoppedOnGlasses();
    await app.settle();
    expect(app.state.phase).toBe("waiting_upload");
    expect(app.state.capture?.id).toBe("session-1");
    app.upload();
    app.poll();
    await app.settle();
    expect(app.state.phase).toBe("processing");
  } finally { app.close(); }
});

test("stop during start uses the confirmed camera ID, and a missing key permits a new capture", async () => {
  const app = await connect();
  try {
    app.button("start");
    await app.settle();
    app.voice("Stop");
    expect(app.state.voiceCommand).toContain("Waiting for Mentra to confirm Start");
    expect(app.requests.some(({ type }) => type === Request.VIDEO_RECORDING_STOP)).toBe(false);
    app.confirmStart();
    await app.settle();
    expect(app.state.phase).toBe("waiting_upload");
    expect(app.requests.find(({ type }) => type === Request.VIDEO_RECORDING_STOP)?.recordingId).toBe("camera-1");
    expect(app.state.capture?.bookmarks).toHaveLength(0);
    app.upload();
    app.poll();
    await app.settle();
    expect(app.state.phase).toBe("processing");
    expect(app.processedMarks).toEqual([[]]);
    app.poll();
    await app.settle();
    expect(app.state.phase).toBe("awaiting_key");
    app.voice("Start");
    await app.settle();
    app.confirmStart();
    await app.settle();
    expect(app.state.phase).toBe("recording");
    expect(app.state.capture?.recordingId).toBe("camera-2");
  } finally { app.close(); }
});
