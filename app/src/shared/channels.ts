import type { Rpc } from "@mentra/miniapp/background";

export type Command = "start" | "snap" | "stop";
export type Phase = "ready" | "recording";
export interface Photo { seq: number; seconds: number; status: "taking" | "uploading" | "saved" | "failed" }
export interface Capture {
  id: string;
  server: string;
  startedAt: number;
  audioSeq: number;
  noteSeq: number;
  photos: Photo[];
}
/** The most recent finished capture, followed until the Mac's report is ready. */
export interface Delivered { id: string; server: string; status: string; progress: string }
export interface State {
  phase: Phase;
  server: string;
  defaultServer: string;
  online: boolean;
  aiConfigured: boolean;
  camera: boolean;
  connected: boolean;
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
  report: Record<string, never>;
  copyDiagnostics: Rpc<Record<string, never>, void>;
}
declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}
