import clsx from "clsx";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Activity, AudioLines, Camera, Check, CircleQuestionMark, ClipboardList, FileText, Hourglass, ListChecks, MessageSquareText,
  MessagesSquare, Paperclip, RotateCw, ShieldAlert, Sparkles, TriangleAlert, Video,
} from "lucide-react";
import { Eta, minutesAgo, statusLook } from "./Board";
import { arrival, clock, identity, live, mediaUrl, snapsInVideo, type Evidence, type Session } from "./data";
import { CrewMessages } from "./Messages";
import { UploadBar } from "./Upload";
import { Button, Heading, Panel, Pill, toneSoft, toneText, useNow, type Tone } from "./ui";
import { severity, vitalKinds, vitalViews, type VitalView } from "./vitals";

/** `when`: shown instead of the time since "start", for a photo the medic sent later. */
export interface PhotoView { id: string; file: string; seconds: number; label: string; caption?: string; clip?: string; when?: string }

// Captured photos: from the processed evidence once the report exists, live from the upload before that.
export function photosOf(session: Session): PhotoView[] {
  const captions = new Map((session.report?.snap_captions ?? []).map(item => [item.evidence_id, item.caption]));
  const processed = session.evidence.filter(item => item.kind === "image" && item.id.startsWith("snap_") && item.file);
  if (processed.length) return processed.map(item => ({ id: item.id, file: item.file!, seconds: item.start, label: item.label ?? "Photo", caption: captions.get(item.id), clip: item.clip }));
  return (session.photos ?? []).map(photo => ({ id: photo.id, file: photo.file, seconds: photo.seconds, label: `Photo ${photo.seq}` }));
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export const fieldLabels: Record<string, string> = {
  patient_age: "Age", patient_sex: "Sex", mechanism: "Mechanism of injury", injuries: "Injuries", blood_pressure: "Blood pressure",
  heart_rate: "Heart rate", spo2: "SpO₂", respiratory_rate: "Respiratory rate", consciousness: "Level of consciousness",
  allergies: "Allergies", medications: "Medications", eta_minutes: "ETA", treatment: "Treatment", history: "Background",
};

type Seek = (seconds: number, prefer?: "audio" | "video") => void;
type Chips = (ids: string[]) => ReactNode;

export function PatientView({ session, now, onPhoto, onRetry, onAttach, onUploadVideo, onMessage }: {
  session: Session;
  now: number;
  onPhoto: (photo: PhotoView, photos: PhotoView[]) => void;
  onRetry: () => Promise<void>;
  onAttach: () => void;
  onUploadVideo: (file: File) => Promise<void>;
  onMessage: (text: string) => Promise<void>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const report = session.report;
  const handoff = report?.handoff ?? null;
  const isLive = live(session, now);
  const vitals = vitalViews(session.vitals, handoff);
  const photos = photosOf(session);
  // Times count from "start"; the glasses' video begins a moment later.
  const offset = !session.has_video && session.video?.state === "ready" ? session.video.offset ?? 0 : 0;
  const seek: Seek = (seconds, prefer = "video") => {
    const media = prefer === "audio" ? audio.current ?? video.current : video.current ?? audio.current;
    if (!media) return;
    media.currentTime = Math.max(0, seconds - (media === video.current ? offset : 0));
    media.scrollIntoView({ behavior: "smooth", block: "center" });
    void media.play().catch(() => {});
  };
  const evidence = new Map(session.evidence.map(item => [item.id, item]));
  const showPhoto = (id: string) => {
    const photo = photos.find(item => item.id === id);
    if (photo) onPhoto(photo, photos);
  };
  const chips: Chips = ids => <EvidenceChips ids={ids} evidence={evidence} onSeek={seek} onPhoto={showPhoto} />;
  const upload = videoUpload(session);
  return <div className="space-y-4">
    <Header session={session} now={now} />
    {!isLive && session.status !== "complete" && <ProcessingBar session={session} now={now} onRetry={onRetry} onAttach={onAttach} />}
    {upload && <UploadBar upload={upload} snaps={snapsInVideo(session).length} />}
    <Alerts vitals={vitals} />
    <VitalsRow vitals={vitals} isLive={isLive} />
    {/* Printed, the columns run one after the other so pages break cleanly. */}
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,1fr)] print:block">
      <div className="space-y-4">
        {isLive && <LiveTranscript session={session} />}
        {handoff ? <Imist session={session} vitals={vitals} chips={chips} /> : <Pending isLive={isLive} />}
        {report && report.summary.length > 0 && <Summary session={session} chips={chips} />}
        {report && report.timeline.length > 0 && <Timeline session={session} chips={chips} />}
      </div>
      <div className="space-y-4 print:mt-4">
        {session.source === "glasses" && <CrewMessages session={session} isLive={isLive} onPhoto={photo => onPhoto(photo, [photo])} onSend={onMessage} />}
        <Photos session={session} photos={photos} onPhoto={photo => onPhoto(photo, photos)} />
        <Media session={session} isLive={isLive} video={video} audio={audio} onUploadVideo={onUploadVideo} />
        {handoff && <AskCrew session={session} vitals={vitals} />}
        {report && report.uncertainties.length > 0 && <CheckFirst items={report.uncertainties} />}
        {!isLive && <Transcript session={session} onSeek={seek} />}
      </div>
    </div>
  </div>;
}

const sources: Record<Session["source"], string> = {
  glasses: "From the medic’s glasses", mac: "Recorded on this Mac", upload: "Imported recording", sample: "Fictional scenario",
};

function Header({ session, now }: { session: Session; now: number }) {
  const look = statusLook(session, now);
  const handoff = session.report?.handoff ?? null;
  const isLive = live(session, now);
  const { who, what } = identity({ handoff, headline: session.report?.title ?? null, title: session.title }, isLive);
  const eta = arrival({ handoff, created_at: session.created_at, capture_seconds: session.capture_seconds ?? null, duration: session.duration });
  return <Panel className={clsx("relative overflow-hidden", isLive && "ring-rose-500/40 dark:ring-rose-400/40")}>
    {isLive && <div aria-hidden className="pointer-events-none absolute -top-28 left-0 h-56 w-2/3 rounded-full bg-rose-500/12 blur-3xl" />}
    <div className="relative flex flex-wrap items-start justify-between gap-6">
      <div className="min-w-0 flex-[1_1_22rem]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Pill tone={look.tone} icon={look.icon}>{isLive ? "Live from the ambulance" : look.label}</Pill>
          {session.source === "sample" && <Pill tone="idle">Training sample</Pill>}
          <span className="text-sm text-slate-500 dark:text-slate-400">{sources[session.source]} · received {minutesAgo(session.created_at, now)}</span>
        </div>
        <h1 className="mt-3 text-[34px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[40px]">
          {who}<span className="mx-2.5 text-slate-300 dark:text-slate-600">·</span><span className="text-slate-700 dark:text-slate-200">{what}</span>
        </h1>
        {session.report?.title && session.report.title !== what && <p className="mt-2 text-base text-slate-500 dark:text-slate-400">{session.report.title}</p>}
        {isLive && <p className="mt-2 text-base text-slate-600 dark:text-slate-300">The medic is talking now. Vitals, photos and what they say appear here as they arrive.</p>}
      </div>
      {eta ? <Eta at={eta} now={now} large /> : isLive ? <Elapsed since={session.created_at} /> : null}
    </div>
  </Panel>;
}

function Elapsed({ since }: { since: string }) {
  const now = useNow(1000);
  return <div className="sm:text-right">
    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-600 dark:text-rose-300">On scene · recording</div>
    <div className="mt-1 text-5xl font-semibold tabular-nums tracking-[-0.03em]">{clock((now - Date.parse(since)) / 1000)}</div>
    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">ETA comes with the handover</div>
  </div>;
}

function ProcessingBar({ session, now, onRetry, onAttach }: { session: Session; now: number; onRetry: () => Promise<void>; onAttach: () => void }) {
  const [sending, setSending] = useState(false);
  const look = statusLook(session, now);
  const working = session.status === "processing";
  const received = session.has_video || Boolean(session.photos?.length || session.notes?.length) || Object.keys(session.audio_parts ?? {}).length > 0;
  const retry = async () => {
    setSending(true);
    try { await onRetry(); } finally { setSending(false); }
  };
  return <div className={clsx("no-print flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 ring-1", toneSoft[look.tone])}>
    {look.icon && <look.icon className={clsx("size-5 shrink-0", toneText[look.tone], working && "animate-spin")} />}
    <div className="min-w-0 flex-1">
      <div className={clsx("text-sm font-semibold", toneText[look.tone])}>{look.label}</div>
      <div className="text-sm text-slate-600 dark:text-slate-300">{session.error || session.progress}</div>
    </div>
    {!session.has_video && (session.source === "upload" || session.source === "mac") && <Button icon={Paperclip} onClick={onAttach}>Attach recording</Button>}
    {received && !working && <Button icon={RotateCw} variant="primary" disabled={sending} onClick={() => void retry()}>
      {session.status === "uploaded" ? "Generate report" : session.status === "waiting_video" ? "Write it without video" : "Retry report"}
    </Button>}
  </div>;
}

// Only what is actually off. Too many alerts and staff stop reading them.
function Alerts({ vitals }: { vitals: VitalView[] }) {
  const items: { tone: Tone; text: string }[] = [];
  for (const vital of vitals) {
    const { label, unit } = vitalKinds.find(item => item.kind === vital.kind)!;
    if (vital.candidates.length) items.push({ tone: "warn", text: `${label} not confirmed: ${vital.candidates.join(" or ")}. Check with the crew.` });
    else if (vital.value && severity(vital.points) === "critical") items.push({ tone: "critical", text: `${label} ${vital.value} ${unit} is in a NEWS2 red band.` });
  }
  if (!items.length) return null;
  return <div className="grid gap-2 md:grid-cols-2">
    {items.map(item => <div key={item.text} role="alert" className={clsx("flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold ring-1", toneSoft[item.tone], toneText[item.tone])}>
      <TriangleAlert className="size-4 shrink-0" strokeWidth={2.5} />{item.text}
    </div>)}
  </div>;
}

const severityStyle = {
  critical: { tone: "critical" as Tone, label: "NEWS2 red band" },
  abnormal: { tone: "warn" as Tone, label: "Outside normal range" },
  normal: { tone: "ok" as Tone, label: "Normal range" },
  unknown: { tone: "idle" as Tone, label: "" },
};
const statusBadge: Record<VitalView["status"], { tone: Tone; label: string }> = {
  confirmed: { tone: "ok", label: "Read back" },
  updated: { tone: "info", label: "Updated" },
  conflict: { tone: "warn", label: "Medic asked to repeat" },
  unconfirmed: { tone: "warn", label: "Not confirmed" },
  heard: { tone: "idle", label: "Heard" },
  reported: { tone: "idle", label: "Reported" },
};

function VitalsRow({ vitals, isLive }: { vitals: VitalView[]; isLive: boolean }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    {vitals.map(vital => {
      const { label, unit } = vitalKinds.find(item => item.kind === vital.kind)!;
      const level = severityStyle[severity(vital.points)];
      const badge = statusBadge[vital.status];
      const unsettled = vital.candidates.length > 0;
      return <div key={vital.kind} className={clsx("relative overflow-hidden rounded-2xl p-4 ring-1 transition-colors print:break-inside-avoid",
        unsettled ? toneSoft.warn : vital.value ? toneSoft[level.tone] : "bg-white ring-slate-200 dark:bg-white/[0.025] dark:ring-white/[0.07]")}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">{label}</span>
          {(vital.value || unsettled) && <span className={clsx("inline-flex items-center gap-1 text-xs font-semibold", toneText[badge.tone])}
            title={vital.status === "confirmed" ? "The glasses read this value back and the medic confirmed it" : undefined}>
            {vital.status === "confirmed" || vital.status === "updated" ? <Check className="size-3.5" strokeWidth={3} /> : unsettled ? <Hourglass className="size-3.5" /> : null}{badge.label}
          </span>}
        </div>
        {unsettled
          ? <div className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-amber-700 tabular-nums dark:text-amber-200">{vital.candidates.join(" or ")}</div>
          : <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className={clsx("text-[46px] font-semibold leading-none tracking-[-0.04em] tabular-nums", vital.value ? toneText[level.tone] : "text-slate-300 dark:text-slate-600")}>{vital.value ?? "—"}</span>
            {vital.value && <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{unit}</span>}
          </div>}
        <div className="mt-2 flex items-end justify-between gap-2">
          <span className={clsx("text-xs font-medium", vital.value ? toneText[level.tone] : "text-slate-500 dark:text-slate-400")}>
            {vital.value ? level.label : unsettled ? "Waiting for the medic" : isLive ? "Not reported yet" : "Not reported"}
          </span>
        </div>
        {vital.history.length > 1 && <div className="mt-1 truncate text-xs tabular-nums text-slate-500 dark:text-slate-400">{vital.history.map(reading => reading.value).join(" → ")}</div>}
      </div>;
    })}
  </div>;
}

// IMIST-AMBO, the order ED staff helped design, so the handover reads the way they expect it.
function Imist({ session, vitals, chips }: { session: Session; vitals: VitalView[]; chips: Chips }) {
  const handoff = session.report!.handoff!;
  const missing = new Set(handoff.missing_fields);
  const empty = (field: string, text = "Not reported") => <span className={clsx("text-sm", missing.has(field) ? "font-medium text-amber-700 dark:text-amber-300" : "font-normal text-slate-400")}>
    {missing.has(field) ? `${text} · ask the crew` : text}
  </span>;
  const signs = vitals.filter(vital => vital.value || vital.candidates.length).map(vital => {
    const { short } = vitalKinds.find(item => item.kind === vital.kind)!;
    return `${short} ${vital.value ?? vital.candidates.join(" or ")}`;
  });
  // Fields the medic filled in by answering the ER, marked with when.
  const sources = handoff.reply_sources ?? {};
  const fromCrew = (...fields: string[]) => fields.map(field => sources[field]?.at).filter(Boolean).sort().at(-1);
  const rows: { letter: string; label: string; content: ReactNode; from?: string }[] = [
    { letter: "I", label: "Identification", from: fromCrew("patient_age", "patient_sex"), content: [handoff.patient_age && `${handoff.patient_age} years`, handoff.patient_sex].filter(Boolean).join(" · ") || empty("patient_age") },
    { letter: "M", label: "Mechanism", from: fromCrew("mechanism"), content: handoff.mechanism || empty("mechanism") },
    {
      letter: "I", label: "Injuries", from: fromCrew("injuries"), content: handoff.injuries.length
        ? <div className="flex flex-wrap gap-1.5">{handoff.injuries.map(injury => <span key={injury} className="rounded-lg bg-rose-500/10 px-2 py-0.5 text-sm font-medium text-rose-800 ring-1 ring-rose-500/20 dark:text-rose-100">{injury}</span>)}</div>
        : empty("injuries"),
    },
    {
      letter: "S", label: "Signs", from: fromCrew("consciousness"), content: <div className="space-y-0.5">
        <div>{handoff.consciousness || empty("consciousness", "Consciousness not reported")}</div>
        {signs.length > 0 && <div className="text-sm font-normal tabular-nums text-slate-500 dark:text-slate-400">{signs.join(" · ")}</div>}
      </div>,
    },
    { letter: "T", label: "Treatment", from: fromCrew("treatment"), content: handoff.treatment?.length ? <ul className="space-y-0.5">{handoff.treatment.map(item => <li key={item}>{item}</li>)}</ul> : <span className="text-sm font-normal text-slate-400">None reported</span> },
    { letter: "A", label: "Allergies", from: fromCrew("allergies"), content: handoff.allergies || empty("allergies") },
    { letter: "M", label: "Medications", from: fromCrew("medications"), content: handoff.medications || empty("medications") },
    { letter: "B", label: "Background", from: fromCrew("history"), content: handoff.history || <span className="text-sm font-normal text-slate-400">Not reported</span> },
    {
      letter: "O", label: "Other", from: fromCrew("eta_minutes"), content: handoff.eta_minutes == null ? empty("eta_minutes")
        : sources.eta_minutes ? `ETA ${handoff.eta_minutes} min, given at ${timeOf(sources.eta_minutes.at)}` : `ETA ${handoff.eta_minutes} min when reported`,
    },
  ];
  return <Panel>
    <Heading icon={ClipboardList} aside={<span className="text-xs font-medium text-slate-500 dark:text-slate-400">IMIST-AMBO</span>}>Handover</Heading>
    <dl className="divide-y divide-slate-200/80 dark:divide-white/[0.06]">
      {rows.map((row, index) => <div key={index} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] print:break-inside-avoid">
        <dt className="flex items-center gap-2.5 text-sm font-medium text-slate-500 dark:text-slate-400">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-emerald-500/12 text-sm font-bold text-emerald-700 dark:text-emerald-300">{row.letter}</span>{row.label}
        </dt>
        <dd className="text-[15px] font-medium leading-snug sm:pt-1">
          {row.content}
          {row.from && <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700 ring-1 ring-sky-500/20 dark:text-sky-300">
            <MessagesSquare className="size-3" />From the crew · {timeOf(row.from)}
          </span>}
        </dd>
      </div>)}
    </dl>
    {handoff.evidence_ids.length > 0 && <div className="no-print mt-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">Sources {chips(handoff.evidence_ids)}</div>}
  </Panel>;
}

function Pending({ isLive }: { isLive: boolean }) {
  return <Panel className="flex items-center gap-4">
    <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-300"><ClipboardList className="size-6" /></div>
    <div>
      <div className="text-lg font-semibold">{isLive ? "The structured handover follows" : "Handover not written yet"}</div>
      <div className="text-sm text-slate-500 dark:text-slate-400">{isLive ? "When the medic says “stop”, Inbound writes the IMIST-AMBO handover from what they said and photographed." : "It appears here once the report is ready."}</div>
    </div>
  </Panel>;
}

function LiveTranscript({ session }: { session: Session }) {
  const notes = (session.notes ?? []).slice(-8);
  return <Panel className="ring-rose-500/25 dark:ring-rose-400/20">
    <Heading icon={MessageSquareText} aside={<Pill tone="live">Live</Pill>}>What the medic is saying</Heading>
    {notes.length ? <ol className="space-y-2.5">
      {notes.map(note => <li key={note.seq} className="flex gap-3">
        <span className="mt-0.5 w-11 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-400">{clock(note.seconds)}</span>
        <p className="text-[15px] leading-snug">{note.text}</p>
      </li>)}
    </ol> : <p className="text-sm text-slate-500 dark:text-slate-400">Listening…</p>}
  </Panel>;
}

function Summary({ session, chips }: { session: Session; chips: Chips }) {
  const report = session.report!;
  return <Panel>
    <Heading icon={Sparkles} aside={<span className="text-xs text-slate-500 dark:text-slate-400">AI draft from the medic’s words · verify</span>}>Summary</Heading>
    <div className="space-y-2.5">
      {report.summary.map((item, index) => <p key={index} className="text-[17px] leading-relaxed">{item.text} {chips(item.evidence_ids)}</p>)}
    </div>
    {report.sections.length > 0 && <details className="mt-4 border-t border-slate-200 pt-3 dark:border-white/[0.06]">
      <summary className="cursor-pointer list-none text-sm font-semibold text-slate-600 dark:text-slate-300 [&::-webkit-details-marker]:hidden">
        Details by topic <span className="font-normal text-slate-400">({report.sections.length})</span>
      </summary>
      <div className="mt-3 space-y-4">
        {report.sections.map(section => <div key={section.heading}>
          <h3 className="text-sm font-semibold">{section.heading}</h3>
          {section.statements.map((item, index) => <p key={index} className="mt-1 text-[15px] leading-relaxed text-slate-600 dark:text-slate-300">{item.text} {chips(item.evidence_ids)}</p>)}
        </div>)}
      </div>
    </details>}
  </Panel>;
}

function Timeline({ session, chips }: { session: Session; chips: Chips }) {
  return <Panel>
    <Heading icon={Activity}>Timeline</Heading>
    <ol className="relative ml-1 space-y-4 border-l border-slate-200 pl-5 dark:border-white/10">
      {session.report!.timeline.map((entry, index) => <li key={index} className="relative">
        <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full bg-emerald-500 ring-4 ring-white dark:ring-[#0c111a]" />
        <div className="flex items-baseline gap-2"><span className="text-xs font-semibold tabular-nums text-slate-400">{clock(entry.seconds)}</span><span className="font-semibold">{entry.title}</span></div>
        <p className="mt-0.5 text-[15px] leading-relaxed text-slate-600 dark:text-slate-300">{entry.detail} {chips(entry.evidence_ids)}</p>
      </li>)}
    </ol>
  </Panel>;
}

function Photos({ session, photos, onPhoto }: { session: Session; photos: PhotoView[]; onPhoto: (photo: PhotoView) => void }) {
  // Snaps taken while the glasses recorded video wait for it: their stills come out of the video.
  const inVideo = snapsInVideo(session);
  const coming = !session.has_video && ["recording", "stopping", "uploading"].includes(session.video?.state ?? "");
  const count = photos.length + inVideo.length;
  return <Panel>
    <Heading icon={Camera} aside={photos.length > 0 && <span className="text-xs font-semibold tabular-nums text-slate-500">{photos.length}</span>}>Injury photos</Heading>
    {count ? <div className="grid grid-cols-2 gap-2.5 print:grid-cols-3">
      {photos.map((photo, index) => <button key={photo.id} onClick={() => onPhoto(photo)}
        className={clsx("group relative overflow-hidden rounded-xl bg-slate-900 text-left ring-1 ring-slate-200 print:col-span-1 print:break-inside-avoid dark:ring-white/10", index === 0 && count % 2 === 1 && "col-span-2")}>
        <img src={mediaUrl(session, photo.file)} alt={photo.caption ?? photo.label} className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2.5 pt-10 text-white print:static print:bg-none print:p-2 print:text-slate-800">
          <div className="flex items-center justify-between text-xs font-semibold"><span>{photo.label}</span><span className="tabular-nums opacity-80">{clock(photo.seconds)}</span></div>
          {photo.caption && <p className="mt-0.5 line-clamp-2 text-xs leading-snug opacity-90">{photo.caption}</p>}
        </div>
      </button>)}
      {inVideo.map(frame => <div key={`frame-${frame.seq}`} className="no-print grid aspect-[4/3] place-items-center rounded-xl border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 dark:border-white/15 dark:text-slate-400">
        <div>
          <Camera className="mx-auto mb-1.5 size-5 opacity-60" />
          <div className="font-semibold text-slate-600 dark:text-slate-300">Snap {frame.seq} · {clock(frame.seconds)}</div>
          <div className="mt-0.5">{coming ? "Arrives with the video" : "Inside the video on the glasses"}</div>
        </div>
      </div>)}
    </div> : <p className="text-sm text-slate-500 dark:text-slate-400">Photos appear here when the medic says “snap”.</p>}
  </Panel>;
}

// The glasses' video on its way, unless it has arrived.
const videoUpload = (session: Session) => session.has_video || session.video?.state === "ready" ? null
  : session.video_upload ?? (session.video?.state === "uploading" ? { mode: "unknown" as const } : null);

const videoNotes: Record<string, string> = {
  starting: "The glasses are starting the video.",
  recording: "The glasses are recording video. It uploads after the medic says “stop”.",
  stopping: "The glasses are stopping the video.",
  uploading: "The glasses are uploading the video. Its progress is at the top of the page.",
  failed: "The glasses could not record or upload video. The handover uses the phone’s audio and photos.",
};

function Media({ session, isLive, video, audio, onUploadVideo }: {
  session: Session; isLive: boolean; video: RefObject<HTMLVideoElement | null>; audio: RefObject<HTMLAudioElement | null>; onUploadVideo: (file: File) => Promise<void>;
}) {
  const [attach, setAttach] = useState<string | null>(null);
  const glasses = !session.has_video ? session.video ?? null : null;
  const videoFile = session.has_video ? "recording.mp4" : glasses?.state === "ready" ? glasses.file ?? null : null;
  // The glasses record silently, so the phone's audio plays alongside their video.
  const audioFile = session.media === "audio" && !(videoFile && glasses?.has_audio) ? "recording.wav" : null;
  const canAttach = session.source === "glasses" && !videoFile && session.capture_finished;
  const upload = async (file: File) => {
    setAttach("Uploading the video…");
    try {
      await onUploadVideo(file);
      setAttach("Video attached. Photo stills are taken from it.");
    } catch (error) {
      setAttach((error as Error).message);
    }
  };
  return <Panel className="print:hidden">
    <Heading icon={videoFile ? Video : AudioLines} aside={session.duration ? <span className="text-xs tabular-nums text-slate-500">{clock(session.duration)}</span> : null}>
      {videoFile ? "Scene video" : "Recording"}
    </Heading>
    <div className="space-y-3">
      {videoFile && <video ref={video} src={mediaUrl(session, videoFile)} controls playsInline preload="metadata" className="aspect-video w-full rounded-xl bg-black" />}
      {videoFile && glasses?.offset ? <p className="text-xs text-slate-500 dark:text-slate-400">The video starts {clock(glasses.offset)} after “start”. Source times are matched to it.</p> : null}
      {audioFile && <div>
        <div className="mb-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">Medic’s voice · phone microphone</div>
        <audio ref={audio} src={mediaUrl(session, audioFile)} controls preload="metadata" className="w-full" />
      </div>}
      {glasses && glasses.state !== "ready" && <div className="flex items-start gap-2 text-sm leading-snug text-slate-500 dark:text-slate-400">
        <Video className="mt-0.5 size-4 shrink-0" />
        <div>
          {videoNotes[glasses.state] ?? "Waiting for the glasses’ video."}
          {glasses.state === "failed" && glasses.detail && <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">Glasses: {glasses.detail}</div>}
        </div>
      </div>}
      {!videoFile && !audioFile && !glasses && <p className="text-sm text-slate-500 dark:text-slate-400">
        {isLive ? "The medic’s audio streams in now. The recording is ready after “stop”." : "The recording appears here once it arrives."}
      </p>}
      {canAttach && <label className="no-print block cursor-pointer rounded-xl border border-dashed border-slate-300 p-3 text-sm leading-snug text-slate-600 transition hover:bg-slate-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-white/[0.03]">
        <span className="font-semibold">Attach the video from the Mentra gallery.</span> If the glasses couldn’t upload it, AirDrop it to this Mac and choose it here.
        <input type="file" accept="video/*" className="sr-only" onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }} />
        {attach && <span role="status" className="mt-2 block text-xs font-medium text-emerald-700 dark:text-emerald-300">{attach}</span>}
      </label>}
    </div>
  </Panel>;
}

function AskCrew({ session, vitals }: { session: Session; vitals: VitalView[] }) {
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const handoff = session.report!.handoff!;
  // A vital the medic gave after the report was written is no longer missing.
  const known = new Set(vitals.filter(vital => vital.value).map(vital => vitalKinds.find(item => item.kind === vital.kind)!.field as string));
  const items = [
    ...vitals.filter(vital => vital.candidates.length).map(vital => `${vitalKinds.find(item => item.kind === vital.kind)!.label}: ${vital.candidates.join(" or ")}?`),
    ...handoff.missing_fields.filter(field => fieldLabels[field] && !known.has(field)).map(field => fieldLabels[field]),
  ];
  if (!items.length) return null;
  const toggle = (item: string) => setAsked(current => {
    const next = new Set(current);
    if (!next.delete(item)) next.add(item);
    return next;
  });
  return <Panel>
    <Heading icon={ListChecks} aside={<span className="text-xs font-semibold tabular-nums text-slate-500">{asked.size}/{items.length}</span>}>Ask the crew on arrival</Heading>
    <ul className="space-y-0.5">
      {items.map(item => <li key={item}>
        <button onClick={() => toggle(item)} className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-[15px] transition hover:bg-slate-100 dark:hover:bg-white/5">
          <span className={clsx("grid size-5 shrink-0 place-items-center rounded-md ring-1 transition", asked.has(item) ? "bg-emerald-500 text-white ring-emerald-500" : "ring-slate-300 dark:ring-white/20")}>
            {asked.has(item) && <Check className="size-3.5" strokeWidth={3} />}
          </span>
          <span className={clsx(asked.has(item) && "text-slate-400 line-through")}>{item}</span>
        </button>
      </li>)}
    </ul>
  </Panel>;
}

// The first few, with the rest a click away: a long list of caveats is a list nobody reads.
function CheckFirst({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 3);
  return <Panel className="ring-amber-500/30 dark:ring-amber-400/20">
    <Heading icon={ShieldAlert} aside={<span className="text-xs font-semibold tabular-nums text-slate-500">{items.length}</span>}>Check before acting</Heading>
    <ul className="space-y-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
      {shown.map(item => <li key={item} className="flex gap-2"><CircleQuestionMark className="mt-0.5 size-4 shrink-0 text-amber-500" />{item}</li>)}
    </ul>
    {items.length > 3 && <button onClick={() => setAll(!all)} className="no-print mt-3 text-sm font-semibold text-amber-700 hover:underline dark:text-amber-300">
      {all ? "Show fewer" : `Show ${items.length - 3} more`}
    </button>}
  </Panel>;
}

function Transcript({ session, onSeek }: { session: Session; onSeek: Seek }) {
  const lines: Evidence[] = session.transcript.length
    ? session.transcript
    : (session.notes ?? []).map(note => ({ id: `note_${note.seq}`, kind: "transcript", start: note.seconds, end: note.seconds, text: note.text }));
  if (!lines.length) return null;
  return <Panel className="print:hidden">
    <details>
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <FileText className="size-4 text-slate-400" strokeWidth={2.25} />
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">Transcript</span>
        <span className="ml-auto text-xs text-slate-500">{lines.length} {lines.length === 1 ? "part" : "parts"} · show</span>
      </summary>
      <div className="mt-3 space-y-3">
        {lines.map(line => <div key={line.id} className="flex gap-3">
          <button onClick={() => onSeek(line.start, "audio")} className="h-6 shrink-0 rounded-md bg-slate-100 px-2 text-xs font-semibold tabular-nums text-slate-600 transition hover:bg-slate-200 dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10">{clock(line.start)}</button>
          <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">{line.text}</p>
        </div>)}
      </div>
    </details>
  </Panel>;
}

function EvidenceChips({ ids, evidence, onSeek, onPhoto }: { ids: string[]; evidence: Map<string, Evidence>; onSeek: Seek; onPhoto: (id: string) => void }) {
  return <>{ids.map(id => {
    const item = evidence.get(id);
    if (!item) return null;
    const photo = item.kind === "image" && id.startsWith("snap_");
    const label = photo ? "Photo" : item.kind === "image" ? "Frame" : item.kind === "vital" ? "Vital" : item.source === "phone" ? "Said" : "Audio";
    return <button key={id} title="Show the source" onClick={() => photo ? onPhoto(id) : onSeek(item.start, item.kind === "image" ? "video" : "audio")}
      className="no-print mx-0.5 inline-flex h-5 items-center rounded-md bg-emerald-500/10 px-1.5 align-middle text-[11px] font-semibold tabular-nums text-emerald-700 ring-1 ring-emerald-500/20 transition hover:bg-emerald-500/20 dark:text-emerald-300">
      {label} {clock(item.start)}
    </button>;
  })}</>;
}
