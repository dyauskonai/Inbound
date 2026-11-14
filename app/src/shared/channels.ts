import type { Rpc } from "@mentra/miniapp/background";

export type Command = "start" | "snap" | "stop";
export type Phase = "ready" | "recording";
/** `from_video`: the camera refused the photo while recording; the server takes the still from the video. */
export interface Photo { seq: number; seconds: number; status: "taking" | "uploading" | "saved" | "failed" | "from_video" }
export interface CaptureVideo {
  state: "starting" | "recording" | "stopping" | "uploading" | "failed";
  recordingId?: string;
  /** Seconds from Start until the glasses confirmed recording. */
  offset?: number;
  detail?: string;
}
export interface Capture {
  id: string;
  server: string;
  startedAt: number;
  audioSeq: number;
  noteSeq: number;
  photos: Photo[];
  video?: CaptureVideo;
}
/** The most recent finished capture, followed until the Mac's report is ready. */
export interface Delivered { id: string; server: string; status: string; progress: string; video?: string }
export interface State {
  phase: Phase;
  server: string;
  defaultServer: string;
  online: boolean;
  aiConfigured: boolean;
  camera: boolean;
  connected: boolean;
  /** Glasses on Wi-Fi: needed only to upload their video. */
  wifi: boolean;
  videoEnabled: boolean;
  battery: number | null;
  audio: boolean;
  voice: string;
  voiceCommand: string;
  heard: string;
  heardFinal: boolean;
  message: string;
  error: string;
  capture: Capture | null;
  delivered: Delivered | null;
  /** Requests waiting to reach the Mac, oldest first. */
  pending: number;
  pendingBytes: number;
  busy: boolean;
  diagnostics: string[];
}
export interface Channels {
  state: State;
  getState: Rpc<Record<string, never>, State>;
  command: { command: Command };
  connect: { server: string };
  video: { enabled: boolean };
  wifi: Record<string, never>;
  report: Record<string, never>;
  copyDiagnostics: Rpc<Record<string, never>, void>;
}
declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}
