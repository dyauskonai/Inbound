import clsx from "clsx";
import { memo, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Film, Plus, Sparkles, Upload, X } from "lucide-react";
import { api, clock, mediaUrl, type Session } from "./data";
import type { PhotoView } from "./Patient";
import { Button, buttonClass } from "./ui";

const dialogClass = "m-auto max-h-[calc(100vh-2rem)] w-[min(640px,calc(100vw-2rem))] overflow-y-auto rounded-2xl bg-white p-0 text-slate-900 shadow-2xl ring-1 ring-slate-200 dark:bg-[#0c111a] dark:text-slate-100 dark:ring-white/10";
const inputClass = "h-10 w-full rounded-xl bg-white px-3 text-sm ring-1 ring-slate-300 outline-none transition placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 dark:bg-white/[0.04] dark:ring-white/10";

function Title({ children, onClose, disabled }: { children: ReactNode; onClose: () => void; disabled?: boolean }) {
  return <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/[0.07]">
    <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
    <button type="button" onClick={onClose} disabled={disabled} aria-label="Close" className="ml-auto grid size-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-white/5">
      <X className="size-5" />
    </button>
  </div>;
}

/** A modal that opens when mounted. The parent unmounts it on close. */
function Modal({ className, locked, onClose, children }: { className?: string; locked?: boolean; onClose: () => void; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} onClose={onClose} onCancel={event => locked && event.preventDefault()} className={clsx(dialogClass, className)}>
    {children(() => ref.current?.close())}
  </dialog>;
}

interface Mark { id: string; seconds: number; label: string }

// A training video, or the recording for a capture that is missing one, with the moments to include.
export function ImportDialog({ attach, onClose, onDone }: { attach: Session | null; onClose: () => void; onDone: (id: string) => void }) {
  const [title, setTitle] = useState(attach?.title ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [marks, setMarks] = useState<Mark[]>(attach?.bookmarks ?? []);
  const [label, setLabel] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  // A retried upload reuses the session the first attempt created.
  const created = useRef<string | null>(attach?.id ?? null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const choose = (next: File | null) => {
    setFile(next);
    setReady(false);
    if (!attach) setMarks([]);
    setPreview(next ? URL.createObjectURL(next) : null);
    if (next && !title) setTitle(next.name.replace(/\.[^.]+$/, "").slice(0, 120));
  };
  const snap = () => {
    if (!player.current || marks.length >= 40) return;
    setMarks([...marks, { id: crypto.randomUUID(), seconds: player.current.currentTime, label: label.trim() || "Snap" }]);
    setLabel("");
  };
  const submit = async (event: FormEvent, close: () => void) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const json = { "Content-Type": "application/json" };
      created.current ??= (await api<Session>("/api/sessions", { method: "POST", headers: json, body: JSON.stringify({ title, source: "upload" }) })).id;
      const id = created.current;
      await api(`/api/sessions/${id}/capture`, { method: "PUT", headers: json, body: JSON.stringify({ bookmarks: marks }) });
      const data = new FormData();
      data.append("video", file);
      await api(`/api/sessions/${id}/video`, { method: "POST", body: data });
      await api(`/api/sessions/${id}/process`, { method: "POST" });
      player.current?.pause();
      close();
      onDone(id);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Modal locked={busy} onClose={onClose}>{close => <form onSubmit={event => void submit(event, close)}>
    <Title onClose={close} disabled={busy}>{attach ? "Attach the recording" : "Import a recording"}</Title>
    <div className="space-y-4 p-5">
      <p className="text-sm text-slate-500 dark:text-slate-400">Upload a training video and mark the moments to include. Inbound writes the handover from it.</p>
      <label className="block space-y-1.5">
        <span className="text-sm font-semibold">Title</span>
        <input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required disabled={Boolean(attach)} placeholder="e.g. Training handover · Unit 04" className={inputClass} />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-semibold">Video file</span>
        <input type="file" accept="video/*" required onChange={event => choose(event.target.files?.[0] ?? null)}
          className="block w-full text-sm text-slate-600 file:mr-3 file:h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-slate-100 file:px-4 file:text-sm file:font-semibold file:text-slate-700 hover:file:bg-slate-200 dark:text-slate-300 dark:file:bg-white/10 dark:file:text-slate-100" />
      </label>
      {preview && <video ref={player} src={preview} controls playsInline onLoadedMetadata={() => setReady(true)} className="aspect-video w-full rounded-xl bg-black" />}
      <div className="flex gap-2">
        <input value={label} onChange={event => setLabel(event.target.value)} maxLength={160} aria-label="Moment label" placeholder="Optional label for this moment" className={inputClass} />
        <Button icon={Plus} onClick={snap} disabled={!ready}>Mark frame</Button>
      </div>
      {marks.length > 0 && <ul className="flex flex-wrap gap-1.5">
        {marks.map(mark => <li key={mark.id} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-500/10 pl-2.5 pr-1 text-sm font-medium text-emerald-800 ring-1 ring-emerald-500/20 dark:text-emerald-200">
          <span className="tabular-nums">{clock(mark.seconds)}</span> · {mark.label}
          <button type="button" aria-label={`Remove ${mark.label}`} onClick={() => setMarks(marks.filter(item => item.id !== mark.id))} className="grid size-6 place-items-center rounded-md hover:bg-emerald-500/15"><X className="size-3.5" /></button>
        </li>)}
      </ul>}
      <p className="text-xs text-slate-500 dark:text-slate-400">The report sends the audio and sampled frames to OpenAI when an API key is configured.</p>
      {error && <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-700 ring-1 ring-rose-500/25 dark:text-rose-300">{error}</p>}
      <Button type="submit" variant="primary" icon={Upload} disabled={busy || !file} className="w-full">{busy ? "Uploading the recording…" : "Upload and write the handover"}</Button>
    </div>
  </form>}</Modal>;
}

export function PhotoDialog({ session, photos, start, onClose }: { session: Session; photos: PhotoView[]; start: string; onClose: () => void }) {
  const [index, setIndex] = useState(() => Math.max(0, photos.findIndex(photo => photo.id === start)));
  const photo = photos[index];
  const step = (by: number) => setIndex(current => (current + by + photos.length) % photos.length);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") step(1);
      if (event.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });
  if (!photo) return null;
  return <Modal className="w-[min(1040px,calc(100vw-2rem))]" onClose={onClose}>{close => <>
    <Title onClose={close}>{photo.label} <span className="ml-1 font-normal tabular-nums text-slate-500">· {photo.when ?? `${clock(photo.seconds)} after “inbound start”`}</span></Title>
    <div className="space-y-4 p-5">
      <div className="relative overflow-hidden rounded-xl bg-black">
        <img src={mediaUrl(session, photo.file)} alt={photo.caption ?? photo.label} className="max-h-[68vh] w-full object-contain" />
        {photos.length > 1 && <>
          <button onClick={() => step(-1)} aria-label="Previous photo" className="absolute left-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/75"><ChevronLeft className="size-6" /></button>
          <button onClick={() => step(1)} aria-label="Next photo" className="absolute right-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/75"><ChevronRight className="size-6" /></button>
          <span className="absolute bottom-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold tabular-nums text-white">{index + 1} / {photos.length}</span>
        </>}
      </div>
      {photo.caption && <div className="flex gap-2.5 rounded-xl bg-slate-50 p-3.5 ring-1 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/[0.07]">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">AI description · verify on arrival</div>
          <p className="mt-1 text-[15px] leading-relaxed">{photo.caption}</p>
        </div>
      </div>}
      {photo.clip && <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500"><Film className="size-3.5" />The moments around this photo</div>
        <video key={photo.clip} src={mediaUrl(session, photo.clip)} controls playsInline className="w-full rounded-xl bg-black" />
      </div>}
    </div>
  </>}</Modal>;
}

// recorder.js drives this markup by element ID, so React renders it once and leaves it alone.
export const RecordDialog = memo(function RecordDialog() {
  return <dialog id="record-dialog" className={dialogClass}>
    <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/[0.07]">
      <h2 className="text-lg font-semibold tracking-tight">Record on this Mac</h2>
      <button id="close-record" aria-label="Close recorder" className="ml-auto grid size-9 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-white/5"><X className="size-5" /></button>
    </div>
    <div className="space-y-3 p-5">
      <p className="text-sm text-slate-500 dark:text-slate-400">The camera and microphone of this computer stand in for the glasses. Voice commands are recognized on this Mac.</p>
      <video id="camera-preview" muted autoPlay playsInline className="aspect-video w-full rounded-xl bg-black object-cover" />
      <div className="flex items-center justify-between">
        <b id="capture-state" className="text-sm font-semibold">Camera is off</b>
        <span id="capture-timer" className="text-2xl font-semibold tabular-nums tracking-tight">0:00</span>
      </div>
      <p id="capture-message" className="text-sm text-slate-500 dark:text-slate-400">Enable the camera, then say “start recording”, “snap”, or “stop recording”.</p>
      <p id="capture-error" role="alert" hidden className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-700 ring-1 ring-rose-500/25 dark:text-rose-300" />
      <div className="flex flex-wrap gap-2">
        <button id="enable-camera" className={buttonClass("primary")}>Enable camera and microphone</button>
        <button id="start-capture" hidden className={buttonClass("primary")}>Start recording</button>
        <button id="snap-capture" hidden className={buttonClass("secondary")}>Snap</button>
        <button id="stop-capture" hidden className={buttonClass("danger")}>Stop recording</button>
        <button id="save-capture" hidden className={buttonClass("primary")}>Retry upload</button>
        <button id="download-capture" hidden className={buttonClass("secondary")}>Download recording</button>
      </div>
      <div id="capture-marks" className="grid grid-cols-3 gap-2 [&_figcaption]:mt-1 [&_figcaption]:text-xs [&_figcaption]:text-slate-500 [&_img]:w-full [&_img]:rounded-lg" />
      <p className="text-xs text-slate-500 dark:text-slate-400">The report sends the audio and selected frames to OpenAI when an API key is configured.</p>
    </div>
  </dialog>;
});
