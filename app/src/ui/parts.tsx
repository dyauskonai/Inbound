import clsx from "clsx";
import type { ComponentType, ReactNode } from "react";
import {
  Camera, Check, CircleAlert, CloudUpload, Droplets, Ear, FileCheck2, Gauge, Glasses, HeartPulse, Hourglass,
  Laptop, LoaderCircle, MessageSquare, Mic, MicOff, Send, Square, TriangleAlert, Video, VideoOff, Volume2, Wind, X,
} from "lucide-react";
import type { Conversation, Photo, State, Vital } from "../shared/channels";
import { commandPhrases } from "../shared/commands";
import type { VitalKind } from "../shared/vitals";

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;
export type Tone = "ok" | "rec" | "warn" | "info" | "idle";

// Status always carries an icon and words too, never color alone.
const toneText: Record<Tone, string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  rec: "text-rose-700 dark:text-rose-300",
  warn: "text-amber-700 dark:text-amber-300",
  info: "text-sky-700 dark:text-sky-300",
  idle: "text-slate-600 dark:text-slate-300",
};
const toneSoft: Record<Tone, string> = {
  ok: "bg-emerald-500/12 ring-emerald-600/25 dark:bg-emerald-400/10 dark:ring-emerald-400/25",
  rec: "bg-rose-500/12 ring-rose-600/25 dark:bg-rose-400/10 dark:ring-rose-400/25",
  warn: "bg-amber-500/15 ring-amber-600/30 dark:bg-amber-400/10 dark:ring-amber-400/30",
  info: "bg-sky-500/12 ring-sky-600/25 dark:bg-sky-400/10 dark:ring-sky-400/25",
  idle: "bg-slate-500/8 ring-slate-400/25 dark:bg-white/5 dark:ring-white/10",
};
const toneDot: Record<Tone, string> = {
  ok: "bg-emerald-500", rec: "bg-rose-500", warn: "bg-amber-500", info: "bg-sky-500", idle: "bg-slate-400",
};

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx("rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80 dark:bg-white/[0.045] dark:shadow-none dark:ring-white/10", className)}>{children}</section>;
}

export function Eyebrow({ icon: Icon, children, className }: { icon?: Icon; children: ReactNode; className?: string }) {
  return <div className={clsx("flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400", className)}>{Icon && <Icon className="size-3.5" strokeWidth={2.5} />}{children}</div>;
}

export function Chip({ tone, icon: Icon, children }: { tone: Tone; icon: Icon; children: ReactNode }) {
  return <span className={clsx("inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold ring-1", toneSoft[tone], toneText[tone])}>
    <Icon className="size-3.5" strokeWidth={2.5} />{children}
  </span>;
}

export function Header({ state }: { state: State | null }) {
  const glasses = state?.connected && state.camera;
  return <header className="flex items-center justify-between gap-3">
    <div className="text-[27px] font-bold tracking-[-0.04em]">inbound<span className="text-emerald-500">↘</span></div>
    <div className="flex shrink-0 gap-1">
      <Chip tone={glasses ? "ok" : "warn"} icon={Glasses}>{glasses ? state?.battery == null ? "On" : `${state.battery}%` : "Off"}</Chip>
      <Chip tone={state?.online ? "ok" : "warn"} icon={Laptop}>{state?.online ? "ER link" : "No link"}</Chip>
      {!!state?.pending && <Chip tone="info" icon={CloudUpload}>{state.pending}</Chip>}
    </div>
  </header>;
}

export function Banner({ tone = "rec", children }: { tone?: Tone; children: ReactNode }) {
  return <div role="alert" className={clsx("flex gap-3 rounded-2xl p-4 ring-1", toneSoft[tone], toneText[tone])}>
    <TriangleAlert className="mt-0.5 size-5 shrink-0" strokeWidth={2.25} />
    <p className="text-[15px] font-medium leading-snug">{children}</p>
  </div>;
}

const commands: [string, string][] = [[commandPhrases.start, "record"], [commandPhrases.snap, "photo"], [commandPhrases.stop, "send"]];

export function StatusHero({ state, now }: { state: State | null; now: number }) {
  if (!state) {
    return <Card className="flex items-center gap-4 py-7">
      <LoaderCircle className="size-8 animate-spin text-slate-400" />
      <div className="text-xl font-semibold">Connecting to Mentra…</div>
    </Card>;
  }
  const capture = state.capture;
  if (state.phase === "recording" && capture) {
    const video = capture.video;
    const videoTone: Tone = !video ? "idle" : video.state === "recording" ? "rec" : video.state === "failed" ? "warn" : "info";
    const videoLabel = !video ? "Audio only" : video.state === "recording" ? "Video" : video.state === "starting" ? "Video starting" : video.state === "failed" ? "No video" : "Video sent";
    return <Card className="relative overflow-hidden ring-rose-500/30 dark:ring-rose-400/30">
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[120%] -translate-x-1/2 rounded-full bg-rose-500/15 blur-3xl" />
      <div className="relative flex items-center gap-3">
        <span className="relative flex size-3.5"><span className="absolute inset-0 rounded-full bg-rose-500 motion-safe:animate-listen" /><span className="relative size-3.5 rounded-full bg-rose-500 motion-safe:animate-beat" /></span>
        <span className="text-sm font-bold uppercase tracking-[0.2em] text-rose-700 dark:text-rose-300">Recording</span>
        <span className="ml-auto"><Chip tone={videoTone} icon={video?.state === "failed" || !video ? VideoOff : Video}>{videoLabel}</Chip></span>
      </div>
      <div role="timer" aria-live="off" className="relative mt-2 text-[76px] font-semibold leading-none tracking-[-0.04em] tabular-nums">{clock(Math.max(0, (now - capture.startedAt) / 1000))}</div>
      <p className="relative mt-3 text-[15px] leading-snug text-slate-600 dark:text-slate-300">{state.message}</p>
    </Card>;
  }
  // Only say "Listening" when voice commands will actually work.
  const glasses = state.connected && state.camera;
  const listening = glasses && state.voice === "Voice commands ready";
  const [title, detail, HeroIcon] = !glasses ? ["Glasses off", "Connect Mentra Live in the Mentra app.", Glasses]
    : listening ? ["Listening", "Say “inbound start” to begin", Mic] : ["Voice loading", state.voice, MicOff];
  return <Card className="py-6">
    <div className="flex items-center gap-4">
      <div className={clsx("relative grid size-16 shrink-0 place-items-center rounded-full", listening ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400")}>
        {listening && <span aria-hidden className="absolute inset-0 rounded-full ring-2 ring-emerald-500/50 motion-safe:animate-listen" />}
        <HeroIcon className="size-8" strokeWidth={2.25} />
      </div>
      <div className="min-w-0">
        <div className="text-[34px] font-semibold leading-tight tracking-[-0.03em]">{title}</div>
        <div className={clsx("text-base leading-snug", listening ? "text-slate-600 dark:text-slate-300" : "text-amber-700 dark:text-amber-300")}>{detail}</div>
      </div>
    </div>
    <div className="mt-5 grid grid-cols-3 gap-2">
      {commands.map(([word, meaning]) => <div key={word} className="flex flex-col justify-center rounded-2xl bg-slate-100 px-2 py-2.5 text-center dark:bg-white/5">
        <div className="text-[17px] font-semibold leading-tight">“{word}”</div>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{meaning}</div>
      </div>)}
    </div>
  </Card>;
}

export function HeardPanel({ state }: { state: State }) {
  const recording = state.phase === "recording";
  const asking = /^Asking/.test(state.voiceCommand);
  const accepted = /accepted|Logged|Changed/.test(state.voiceCommand);
  return <Card className="py-4">
    <Eyebrow icon={Ear}>{state.heard ? state.heardFinal ? recording ? "Heard" : "Heard · not sent" : "Listening" : "Listening"}</Eyebrow>
    <p className={clsx("mt-1.5 line-clamp-2 text-[19px] leading-snug", !state.heard && "text-slate-400 dark:text-slate-500")}>
      {state.heard ? `“${state.heard}”` : recording ? "Speak naturally. Commands work mid-sentence." : "Nothing is recorded or sent until you start."}
    </p>
    {state.voiceCommand && <div className={clsx("mt-3 flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[15px] font-medium leading-snug ring-1", toneSoft[asking ? "warn" : accepted ? "ok" : "idle"], toneText[asking ? "warn" : accepted ? "ok" : "idle"])}>
      {asking ? <Ear className="mt-0.5 size-4 shrink-0" /> : accepted ? <Check className="mt-0.5 size-4 shrink-0" strokeWidth={3} /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
      {state.voiceCommand}
    </div>}
  </Card>;
}

const vitalRows: { kind: VitalKind; label: string; unit: string; icon: Icon; hint: string }[] = [
  { kind: "bp", label: "Blood pressure", unit: "mmHg", icon: Gauge, hint: "“BP 120 over 80”" },
  { kind: "hr", label: "Heart rate", unit: "bpm", icon: HeartPulse, hint: "“heart rate 90”" },
  { kind: "spo2", label: "SpO₂", unit: "%", icon: Droplets, hint: "“sats 98”" },
  { kind: "rr", label: "Resp. rate", unit: "/min", icon: Wind, hint: "“resp rate 16”" },
];
const vitalStatus: Record<Vital["status"], { tone: Tone; label: string; icon: Icon }> = {
  heard: { tone: "idle", label: "Heard", icon: Ear },
  conflict: { tone: "warn", label: "Asked to repeat", icon: Hourglass },
  confirmed: { tone: "ok", label: "Confirmed", icon: Check },
  updated: { tone: "info", label: "Updated", icon: Check },
  unconfirmed: { tone: "warn", label: "Not confirmed", icon: CircleAlert },
};

export function VitalsGrid({ vitals, live }: { vitals: Vital[]; live: boolean }) {
  return <Card className="p-4">
    <div className="mb-3 flex items-center justify-between px-1">
      <Eyebrow icon={HeartPulse}>Vitals</Eyebrow>
      <span className="text-xs text-slate-500 dark:text-slate-400">{live ? "Say a vital again to change it" : "Last capture"}</span>
    </div>
    <div className="grid grid-cols-2 gap-2.5">
      {vitalRows.map(({ kind, label, unit, icon: Icon, hint }) => {
        const vital = vitals.find(item => item.kind === kind);
        const status = vital ? vitalStatus[vital.status] : null;
        const StatusIcon = status?.icon ?? Ear;
        const both = vital && (vital.status === "conflict" || vital.status === "unconfirmed") && vital.candidates?.length;
        return <div key={kind} className={clsx("flex min-h-[124px] flex-col rounded-2xl p-3.5 ring-1", status ? toneSoft[status.tone] : "bg-slate-50 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/10", vital?.status === "conflict" && "motion-safe:animate-beat")}>
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-600 dark:text-slate-300"><Icon className="size-4" strokeWidth={2.25} />{label}</div>
          {vital ? <>
            <div className="mt-1.5 flex items-baseline gap-1">
              <span className={clsx("font-semibold tabular-nums tracking-[-0.03em]", both ? "text-[22px] leading-tight" : "text-[34px] leading-none")}>{both ? vital.candidates!.join(" or ") : vital.value}</span>
              {!both && <span className="text-sm font-medium text-slate-500 dark:text-slate-400">{unit}</span>}
            </div>
            <div className={clsx("mt-auto flex items-center gap-1 pt-2 text-[13px] font-semibold", toneText[status!.tone])}><StatusIcon className="size-3.5" strokeWidth={3} />{status!.label}</div>
          </> : <>
            <div className="mt-1.5 text-[34px] font-semibold leading-none text-slate-300 dark:text-slate-600">—</div>
            <div className="mt-auto pt-2 text-[13px] text-slate-500 dark:text-slate-400">{live ? `Say ${hint}` : "Not reported"}</div>
          </>}
        </div>;
      })}
    </div>
  </Card>;
}

const photoStatus: Record<Photo["status"], { tone: Tone; icon: Icon; label: string }> = {
  taking: { tone: "info", icon: LoaderCircle, label: "Taking" },
  uploading: { tone: "info", icon: CloudUpload, label: "Sending" },
  saved: { tone: "ok", icon: Check, label: "Sent" },
  failed: { tone: "rec", icon: X, label: "Failed" },
  from_video: { tone: "info", icon: Video, label: "From video" },
};

export function PhotoStrip({ photos }: { photos: Photo[] }) {
  return <Card className="py-4">
    <Eyebrow icon={Camera}>Photos · {photos.length}</Eyebrow>
    {photos.length ? <div className="mt-3 flex flex-wrap gap-2">
      {photos.map(photo => {
        const status = photoStatus[photo.status];
        return <span key={photo.seq} className={clsx("inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold ring-1", toneSoft[status.tone], toneText[status.tone])}>
          <status.icon className={clsx("size-4", photo.status === "taking" && "animate-spin")} strokeWidth={2.5} />#{photo.seq} {clock(photo.seconds)} · {status.label}
        </span>;
      })}
    </div> : <p className="mt-1.5 text-[15px] text-slate-500 dark:text-slate-400">Say “snap” while looking at the injury.</p>}
  </Card>;
}

const delivery: Record<string, { tone: Tone; icon: Icon; title: string }> = {
  uploading: { tone: "info", icon: CloudUpload, title: "Sending to the ER" },
  processing: { tone: "info", icon: LoaderCircle, title: "Writing the report" },
  uploaded: { tone: "info", icon: LoaderCircle, title: "Writing the report" },
  waiting_video: { tone: "info", icon: Video, title: "Waiting for glasses video" },
  complete: { tone: "ok", icon: FileCheck2, title: "Report ready at the ER" },
  awaiting_key: { tone: "warn", icon: CircleAlert, title: "Saved · AI key needed" },
  failed: { tone: "rec", icon: TriangleAlert, title: "Needs attention" },
  interrupted: { tone: "warn", icon: CircleAlert, title: "Interrupted" },
};

export function DeliveredCard({ delivered, onOpen }: { delivered: NonNullable<State["delivered"]>; onOpen: () => void }) {
  const look = delivery[delivered.status] ?? delivery.processing;
  const busy = look.icon === LoaderCircle;
  return <Card>
    <Eyebrow>Last capture</Eyebrow>
    <div className="mt-2 flex items-center gap-3">
      <div className={clsx("grid size-12 shrink-0 place-items-center rounded-2xl ring-1", toneSoft[look.tone], toneText[look.tone])}><look.icon className={clsx("size-6", busy && "animate-spin")} strokeWidth={2.25} /></div>
      <div className="min-w-0">
        <div className="text-xl font-semibold tracking-tight">{look.title}</div>
        <div className="text-sm leading-snug text-slate-500 dark:text-slate-400">
          {delivered.progress}{delivered.video === "ready" ? " Video is on the dashboard." : delivered.video === "uploading" ? " Video is uploading from the glasses." : ""}
        </div>
      </div>
    </div>
    <button onClick={onOpen} className="mt-4 h-14 w-full rounded-2xl bg-slate-100 text-base font-semibold ring-1 ring-slate-200 transition active:scale-[0.99] dark:bg-white/5 dark:ring-white/10">Open on the dashboard ↗</button>
  </Card>;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const photoNotes: Partial<Record<Conversation["photo"], string>> = {
  taking: "Taking the photo…", attached: "Photo attached.", failed: "The photo failed. Say “snap” to try again.",
};
const roomy = "flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-slate-100 text-base font-semibold ring-1 ring-slate-200 transition active:scale-[0.99] dark:bg-white/5 dark:ring-white/10";

// The ER's message being read on the glasses, and the medic's spoken reply. No history: it
// clears once the reply is sent, and the conversation stays on the ER's dashboard.
export function MessageCard({ conversation, onReadAgain, onReply }: { conversation: Conversation; onReadAgain: () => void; onReply: () => void }) {
  const message = conversation.current;
  if (!message) return null;
  const photo = photoNotes[conversation.photo];
  return <Card className={clsx("space-y-3", conversation.listening && "ring-2 ring-sky-500/60 dark:ring-sky-400/50")}>
    <Eyebrow icon={MessageSquare}>Message from the ER · {timeOf(message.at)}</Eyebrow>
    <p className="text-[19px] font-semibold leading-snug">{message.text}</p>
    {conversation.sent
      ? <div role="status" className="flex items-center gap-2 rounded-2xl bg-emerald-500/12 p-4 text-base font-semibold text-emerald-800 ring-1 ring-emerald-500/25 dark:bg-emerald-400/10 dark:text-emerald-200">
        <Check className="size-5" strokeWidth={2.5} />Reply sent to the ER
      </div>
      : conversation.listening
      ? <div role="status" className="rounded-2xl bg-sky-500/12 p-4 ring-1 ring-sky-500/25 dark:bg-sky-400/10">
        <div className="flex items-center gap-2 text-base font-semibold text-sky-800 dark:text-sky-200"><Mic className="size-5 motion-safe:animate-beat" />Listening for your reply</div>
        <p className="mt-1 text-[15px] leading-snug">{conversation.draft || "Speak now. Say “snap” to add a photo."}</p>
        {photo && <p className="mt-1 text-sm font-medium text-slate-600 dark:text-slate-300">{photo}</p>}
      </div>
      : <div className="grid grid-cols-2 gap-2">
        <button onClick={onReadAgain} className={roomy}><Volume2 className="size-5" />Read again</button>
        <button onClick={onReply} className={roomy}><Mic className="size-5" />Reply</button>
      </div>}
  </Card>;
}

function BigButton({ icon: Icon, label, hint, className, disabled, onClick }: { icon: Icon; label: string; hint: string; className: string; disabled?: boolean; onClick: () => void }) {
  return <button disabled={disabled} onClick={onClick} className={clsx("flex h-[104px] flex-col items-center justify-center gap-1 rounded-[28px] shadow-lg transition active:scale-[0.98] disabled:opacity-40", className)}>
    <span className="flex items-center gap-2.5 text-[26px] font-semibold tracking-tight"><Icon className="size-7" strokeWidth={2.5} />{label}</span>
    <span className="text-sm font-medium opacity-80">{hint}</span>
  </button>;
}

export function ActionBar({ state, onCommand }: { state: State | null; onCommand: (command: "start" | "snap" | "stop") => void }) {
  const recording = state?.phase === "recording";
  const answering = !recording && state?.conversation?.listening;
  return <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-slate-100 from-60% to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom))] dark:from-[#05080f]">
    <div className="mx-auto max-w-md">
      {answering
        ? <div className="grid grid-cols-2 gap-3">
          <BigButton icon={Camera} label="Photo" hint="or say “snap”" onClick={() => onCommand("snap")} className="bg-sky-400 text-sky-950 shadow-sky-500/20" />
          <BigButton icon={Send} label="Send" hint="or just pause" onClick={() => onCommand("stop")} className="bg-emerald-500 text-emerald-950 shadow-emerald-500/20" />
        </div>
        : recording
        ? <div className="grid grid-cols-2 gap-3">
          <BigButton icon={Camera} label="Snap" hint="or say “snap”" onClick={() => onCommand("snap")} className="bg-sky-400 text-sky-950 shadow-sky-500/20" />
          <BigButton icon={Square} label="Stop" hint="or say “inbound stop”" onClick={() => onCommand("stop")} className="bg-rose-600 text-white shadow-rose-600/25" />
        </div>
        : <BigButton icon={Mic} label="Start recording" hint="or say “inbound start”" disabled={!state?.server} onClick={() => onCommand("start")} className="w-full bg-emerald-500 text-emerald-950 shadow-emerald-500/20" />}
    </div>
  </div>;
}
