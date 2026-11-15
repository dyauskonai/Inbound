// What the Inbound server sends the ER dashboard.
export type VitalKind = "bp" | "hr" | "spo2" | "rr";
export interface Vital {
  seq: number;
  kind: VitalKind;
  value: string;
  status: "heard" | "conflict" | "confirmed" | "updated" | "unconfirmed";
  seconds: number;
  candidates: string[];
}
export interface Handoff {
  patient_age: string | null;
  patient_sex: string | null;
  mechanism: string | null;
  injuries: string[];
  blood_pressure: string | null;
  heart_rate: string | null;
  spo2: string | null;
  respiratory_rate: string | null;
  consciousness?: string | null;
  treatment?: string[];
  allergies: string | null;
  medications?: string | null;
  history?: string | null;
  eta_minutes: number | null;
  missing_fields: string[];
  evidence_ids: string[];
  confirmed_fields?: string[];
  updated_fields?: string[];
  unconfirmed_fields?: string[];
  /** Fields the medic filled in later, answering the ER: the reply each came from. */
  reply_sources?: Record<string, { id: string; at: string }>;
  /** When an ETA the medic gave in a reply runs out. */
  eta_at?: string | null;
}
export interface Statement { text: string; evidence_ids: string[] }
export interface Report {
  title: string;
  summary: Statement[];
  sections: { heading: string; statements: Statement[] }[];
  timeline: { seconds: number; title: string; detail: string; evidence_ids: string[] }[];
  uncertainties: string[];
  snap_captions?: { evidence_id: string; caption: string }[];
  handoff?: Handoff;
}
export interface Evidence {
  id: string;
  kind: "image" | "transcript" | "vital";
  start: number;
  end: number;
  label?: string;
  file?: string;
  clip?: string;
  text?: string;
  source?: string;
}
export interface Photo { id: string; seq: number; seconds: number; file: string; from_video?: boolean }
/** A message about a capture: the ER's, read aloud on the glasses, or the medic's spoken reply. */
export interface ChatMessage {
  id: string; from: "er" | "medic"; text: string; at: string; heard_at?: string | null; reply_to?: string | null; photo?: string | null;
  /** The reply as the recognizer heard it, before the glasses' own voice was taken out. */
  heard?: string;
  /** The reply tidied by the AI, for reading. */
  clean?: string | null;
  /** Vitals the reply logged, read back to the medic. */
  vitals?: { kind: VitalKind; value: string }[];
  /** What the reply added to the handoff card. */
  added?: Record<string, unknown>;
}
/** How far the glasses' video upload has got: counted once its bytes reach the server, estimated while the tunnel holds them. */
export interface UploadProgress { mode: "measured" | "estimated" | "unknown"; received?: number; total?: number; since?: string; rate?: number }
export interface Session {
  id: string;
  title: string;
  source: "glasses" | "upload" | "mac" | "sample";
  created_at: string;
  updated_at: string;
  status: string;
  progress: string;
  error: string | null;
  duration: number | null;
  has_video: boolean;
  has_audio: boolean;
  media?: "audio" | null;
  report: Report | null;
  evidence: Evidence[];
  transcript: Evidence[];
  bookmarks: { id: string; seconds: number; label: string }[];
  photos?: Photo[];
  notes?: { seq: number; seconds: number; text: string }[];
  vitals?: Vital[];
  video?: { state: string; file?: string; offset?: number; duration?: number; has_audio?: boolean; detail?: string | null };
  capture_seconds?: number;
  capture_finished?: boolean;
  audio_parts?: Record<string, unknown>;
  /** Snaps said while the glasses recorded video. Their stills come out of the video. */
  video_frames?: { seq: number; seconds: number }[];
  video_upload?: UploadProgress | null;
  messages?: ChatMessage[];
}
/** One row of the incoming board. */
export interface SessionCard {
  id: string;
  title: string;
  source: Session["source"];
  created_at: string;
  updated_at: string;
  status: string;
  progress: string;
  duration: number | null;
  capture_seconds: number | null;
  headline: string | null;
  handoff: Handoff | null;
  vitals: Vital[];
  photo_count: number;
  video_state: string | null;
  video_upload?: UploadProgress | null;
  message_count?: number;
  reply_count?: number;
}
export interface Health { ok: boolean; ai_configured: boolean; video_upload_url?: string | null }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof data?.detail === "string" ? data.detail : "Could not complete this request. Check your input and try again.");
  }
  return data as T;
}

export const mediaUrl = (session: Pick<Session, "id">, name: string) => `/media/${session.id}/${encodeURIComponent(name)}`;
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
const QUIET_MS = 10 * 60_000;
/** Still coming in from the ambulance. A capture that has sent nothing for ten minutes has lost its signal. */
export const live = (card: Pick<SessionCard, "status" | "updated_at">, now = Date.now()) =>
  (card.status === "recording" || card.status === "created") && now - Date.parse(card.updated_at) < QUIET_MS;

/** The patient as one line: "45 M · Motorcycle crash". */
export function identity(card: Pick<SessionCard, "handoff" | "headline" | "title">, talking = false) {
  const handoff = card.handoff;
  const who = [handoff?.patient_age, handoff?.patient_sex?.[0]?.toUpperCase()].filter(Boolean).join(" ");
  // The phone names a capture "Glasses capture · <time>", which says nothing while it is still coming in.
  const fallback = talking && /^Glasses (capture|recording)/.test(card.title) ? "Handover in progress" : card.title;
  return { who: who || "Unknown patient", what: handoff?.mechanism || handoff?.injuries?.[0] || card.headline || fallback };
}

/**
 * The share of an upload done: real when counted, estimated from speed otherwise. An estimate that
 * runs out is `overdue`: the upload is slower than the last one, and how far it has got is unknown.
 */
export function uploadShare(upload: UploadProgress, now: number) {
  const elapsed = upload.since ? Math.max(0, (now - Date.parse(upload.since)) / 1000) : 0;
  if (upload.mode === "measured" && upload.total) {
    const sent = Math.min(upload.received ?? 0, upload.total);
    const left = sent > 0 && elapsed > 2 ? (upload.total - sent) / (sent / elapsed) : null;
    return { fraction: sent / upload.total, sent, total: upload.total, left, elapsed, estimated: false, overdue: false };
  }
  if (upload.mode === "estimated" && upload.total && upload.rate && upload.since) {
    const sent = Math.min(upload.total, elapsed * upload.rate);
    const left: number | null = (upload.total - sent) / upload.rate;
    return { fraction: Math.min(0.97, sent / upload.total), sent, total: upload.total, left, elapsed, estimated: true, overdue: sent >= upload.total };
  }
  return null;
}

/** Snaps still inside a video that hasn't arrived. */
export const snapsInVideo = (session: Session) =>
  (session.video_frames ?? []).filter(frame => !(session.photos ?? []).some(photo => photo.seq === frame.seq));

/** How long after its ETA an ambulance still counts as arriving. */
export const ARRIVING_MS = 15 * 60_000;

/** On the way: still talking, its report or video still coming, or due within the last few minutes. */
export const inbound = (card: Pick<SessionCard, "status" | "updated_at" | "handoff" | "created_at" | "capture_seconds" | "duration" | "video_upload">, now: number) =>
  live(card, now) || (arrival(card) ?? 0) > now - ARRIVING_MS || Boolean(card.video_upload)
  || (["uploaded", "processing", "waiting_video"].includes(card.status) && now - Date.parse(card.updated_at) < QUIET_MS);

/** The ETA the medic gave, counted from when the capture ended. Approximate by nature. */
export function arrival(card: Pick<SessionCard, "handoff" | "created_at" | "capture_seconds" | "duration">) {
  const minutes = card.handoff?.eta_minutes;
  if (minutes == null) return null;
  // An ETA the medic gave in a reply counts from then.
  if (card.handoff?.eta_at) return Date.parse(card.handoff.eta_at);
  const ended = Date.parse(card.created_at) + (card.capture_seconds ?? card.duration ?? 0) * 1000;
  return ended + minutes * 60_000;
}
