import type { Rpc } from "@mentra/miniapp/background";

export type Command = "start" | "snap" | "stop";
export type Phase = "ready" | "starting" | "recording" | "stopping" | "waiting_upload" | "processing" | "awaiting_key" | "complete";
export interface Bookmark { id: string; seconds: number; label: string }
export interface Capture {
  id: string;
  recordingId?: string;
  startedAt: number;
  bookmarks: Bookmark[];
  phase: Phase;
  server: string;
}
export interface State {
  phase: Phase;
  server: string;
  online: boolean;
  aiConfigured: boolean;
  camera: boolean;
  connected: boolean;
  wifi: boolean;
  battery: number | null;
  voice: string;
  heard: string;
  message: string;
  error: string;
  capture: Capture | null;
  busy: boolean;
}
export interface Channels {
  state: State;
  getState: Rpc<Record<string, never>, State>;
  command: { command: Command };
  connect: { server: string };
  retry: Record<string, never>;
  wifi: Record<string, never>;
  resetUnconfirmedStart: Record<string, never>;
  report: Record<string, never>;
}
declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}
