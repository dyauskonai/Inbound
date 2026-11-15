import type { Rpc } from "@mentra/miniapp/background";
import type { VitalKind } from "./vitals";

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
  vitalSeq: number;
  video?: CaptureVideo;
  /** Secret the glasses present to upload this capture's video through the server's tunnel. */
  uploadToken: string;
}
/**
 * A critical vital as Inbound last logged it. `conflict`: two different values close together,
 * so the glasses asked the medic to repeat it. `confirmed`: the medic's answer.
 * `updated`: the medic later changed a logged value. `unconfirmed`: no answer came.
 */
export interface Vital { kind: VitalKind; value: string; status: "heard" | "conflict" | "confirmed" | "updated" | "unconfirmed"; candidates?: string[] }
/** A message about a finished capture: the ER's, read aloud on the glasses, or the medic's spoken reply. */
export interface ChatMessage {
  id: string; from: "er" | "medic"; text: string; at: string; heard_at?: string | null; reply_to?: string | null; photo?: string | null;
  /** The reply tidied by the server's AI, for reading. */
  clean?: string | null;
}
/**
 * The ER's message being read to the medic about the last finished capture, and their reply.
 * Only the current message: the phone keeps no history, which stays on the ER's dashboard.
 * `listening`: the medic's next words are the reply. `photo`: one they add by saying "snap".
 * `sent`: the reply went, and the message clears once the glasses confirm it.
 */
export interface Conversation {
  session: string; current: ChatMessage | null; listening: boolean; draft: string; photo: "none" | "taking" | "attached" | "failed"; sent: boolean;
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
  /** The glasses' Wi-Fi name and address, to compare with the server's network. */
  glassesNetwork: string;
  glassesIp: string;
  /** Result of the last "Test video upload". */
  uploadCheck: string;
  /** Internet address the glasses upload video to, when the server runs a tunnel. */
  videoUploadBase: string;
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
  /** The current capture's vitals, latest per kind. */
  vitals: Vital[];
  delivered: Delivered | null;
  conversation: Conversation | null;
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
  checkUpload: Record<string, never>;
  checkSpeaker: Record<string, never>;
  report: Record<string, never>;
  /** Read the ER's latest message aloud again, then listen for a reply. */
  readAgain: Record<string, never>;
  /** Listen for a reply to the ER's latest message. */
  reply: Record<string, never>;
  copyDiagnostics: Rpc<Record<string, never>, void>;
}
declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}
