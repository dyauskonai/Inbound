import type { Rpc } from "@mentra/miniapp/background";

export type Command = "start" | "snap" | "stop";
export type Phase = "ready" | "starting" | "start_unconfirmed" | "recording" | "stopping" | "waiting_upload" | "processing" | "awaiting_key" | "complete";
export interface Bookmark { id: string; seconds: number; label: string }
export interface Capture {
  id: string;
  recordingId?: string;
  live?: boolean;
  streamId?: string;
  startedAt: number;
  bookmarks: Bookmark[];
  phase: Phase;
  server: string;
}
export interface State {
  phase: Phase;
  server: string;
  defaultServer: string;
  localServer: string;
  liveOnly: boolean;
  captureMode: "live" | "device";
  autoUpload: boolean;
  streamUpdateRequired: boolean;
  online: boolean;
  aiConfigured: boolean;
  camera: boolean;
  connected: boolean;
  wifi: boolean;
  battery: number | null;
  voice: string;
  voiceCommand: string;
  heard: string;
  heardFinal: boolean;
  message: string;
  error: string;
  capture: Capture | null;
  busy: boolean;
  stopPending: boolean;
  diagnostics: string[];
}
export interface Channels {
  state: State;
  getState: Rpc<Record<string, never>, State>;
  command: { command: Command };
  connect: { server: string };
  captureMode: { mode: State["captureMode"] };
  autoUpload: { enabled: boolean };
  retry: Record<string, never>;
  wifi: Record<string, never>;
  resetUnconfirmedStart: Record<string, never>;
  confirmStoppedOnGlasses: Record<string, never>;
  newCapture: Record<string, never>;
  stopPublisher: Record<string, never>;
  report: Record<string, never>;
  copyDiagnostics: Rpc<Record<string, never>, void>;
}
declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}
