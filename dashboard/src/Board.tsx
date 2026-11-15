import clsx from "clsx";
import { Ambulance, Camera, CircleAlert, FileCheck2, FileClock, Hourglass, LoaderCircle, MessagesSquare, TriangleAlert, Video, WifiOff } from "lucide-react";
import { ARRIVING_MS, arrival, identity, live, type SessionCard } from "./data";
import { Pill, type Icon, type Tone } from "./ui";
import { UploadMini } from "./Upload";
import { severity, vitalViews } from "./vitals";

export function statusLook(card: Pick<SessionCard, "status" | "updated_at">, now: number): { tone: Tone; label: string; icon?: Icon } {
  if ((card.status === "recording" || card.status === "created") && !live(card, now)) return { tone: "idle", label: "No signal", icon: WifiOff };
  return lookOf[card.status] ?? { tone: "idle", label: card.status };
}
const lookOf: Record<string, { tone: Tone; label: string; icon?: Icon }> = {
  recording: { tone: "live" as Tone, label: "Live" },
  created: { tone: "live" as Tone, label: "Starting" },
  uploaded: { tone: "info" as Tone, label: "Ready for report", icon: FileClock },
  processing: { tone: "info" as Tone, label: "Writing report", icon: LoaderCircle },
  waiting_video: { tone: "info" as Tone, label: "Awaiting video", icon: Video },
  complete: { tone: "ok" as Tone, label: "Report ready", icon: FileCheck2 },
  awaiting_key: { tone: "warn" as Tone, label: "AI key needed", icon: CircleAlert },
  failed: { tone: "critical" as Tone, label: "Needs attention", icon: TriangleAlert },
  interrupted: { tone: "warn" as Tone, label: "Interrupted", icon: CircleAlert },
};

export function minutesAgo(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function Eta({ at, now, large }: { at: number; now: number; large?: boolean }) {
  const minutes = Math.round((at - now) / 60_000);
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Long past the ETA the ambulance is here, and a countdown means nothing.
  const past = at < now - ARRIVING_MS;
  if (large) {
    return <div className="sm:text-right">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">{past ? "ETA was" : "ETA · approx."}</div>
      <div className="mt-1 text-5xl font-semibold tabular-nums tracking-[-0.03em]">
        {minutes > 0 ? <>{minutes}<span className="ml-1 text-xl text-slate-500">min</span></> : <span className={clsx("text-3xl", past && "text-slate-400")}>{past ? time : "Arriving now"}</span>}
      </div>
      {!past && <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">around {time}</div>}
    </div>;
  }
  if (past) return null;
  return <span className="inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-sky-700 dark:text-sky-300">
    <Ambulance className="size-3.5" strokeWidth={2.5} />{minutes > 0 ? `ETA ${minutes} min` : "Arriving now"}
  </span>;
}

const severityText = { critical: "text-rose-600 dark:text-rose-300", abnormal: "text-amber-600 dark:text-amber-300", normal: "text-slate-700 dark:text-slate-200", unknown: "text-slate-700 dark:text-slate-200" };

export function Board({ cards, selectedId, onSelect, now }: { cards: SessionCard[]; selectedId: string | null; onSelect: (id: string) => void; now: number }) {
  if (!cards.length) {
    return <div className="rounded-2xl border border-dashed border-slate-300 p-5 text-center text-sm leading-relaxed text-slate-500 dark:border-white/10 dark:text-slate-400">
      No ambulances on the way.<br />A card appears here the moment a medic says “start”.
    </div>;
  }
  return <ul className="space-y-2">
    {cards.map(card => {
      const look = statusLook(card, now);
      const { who, what } = identity(card, live(card, now));
      const eta = arrival(card);
      const vitals = vitalViews(card.vitals, card.handoff).filter(vital => vital.kind !== "rr");
      const reported = vitals.some(vital => vital.value || vital.candidates.length);
      const selected = card.id === selectedId;
      return <li key={card.id}>
        <button onClick={() => onSelect(card.id)} className={clsx(
          "group w-full rounded-2xl p-3.5 text-left ring-1 transition",
          selected ? "bg-white shadow-md ring-emerald-500/60 dark:bg-white/[0.07] dark:ring-emerald-400/50" : "bg-white/60 ring-slate-200 hover:bg-white dark:bg-white/[0.025] dark:ring-white/[0.07] dark:hover:bg-white/[0.05]",
          live(card, now) && !selected && "ring-rose-500/40 dark:ring-rose-400/35",
        )}>
          <div className="flex items-center gap-2">
            <Pill tone={look.tone} icon={look.icon}>{look.label}</Pill>
            {card.source === "sample" && <Pill tone="idle">Sample</Pill>}
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{minutesAgo(card.created_at, now)}</span>
          </div>
          <div className="mt-2.5 truncate text-[15px] font-semibold">{who} <span className="font-normal text-slate-400">·</span> <span className="font-medium text-slate-600 dark:text-slate-300">{what}</span></div>
          {reported && <div className="mt-2 flex items-center gap-3 text-xs">
            {vitals.map(vital => <span key={vital.kind} className={clsx("tabular-nums", severityText[severity(vital.points)])}>
              <span className="mr-1 font-medium text-slate-400">{vital.kind === "bp" ? "BP" : vital.kind === "hr" ? "HR" : "SpO₂"}</span>
              <span className="font-semibold">{vital.value ?? (vital.candidates.length ? "?" : "—")}</span>
            </span>)}
          </div>}
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-500 empty:hidden dark:text-slate-400">
            {eta && <Eta at={eta} now={now} />}
            {card.photo_count > 0 && <span className="inline-flex items-center gap-1"><Camera className="size-3.5" />{card.photo_count}</span>}
            {card.video_state === "ready" && <span className="inline-flex items-center gap-1"><Video className="size-3.5" />Video</span>}
            {(card.message_count ?? 0) > 0 && <span className={clsx("inline-flex items-center gap-1", card.reply_count && "font-semibold text-emerald-700 dark:text-emerald-300")}>
              <MessagesSquare className="size-3.5" />{card.reply_count ? `${card.reply_count} ${card.reply_count === 1 ? "reply" : "replies"}` : "Asked"}
            </span>}
            {card.video_upload
              ? <UploadMini upload={card.video_upload} />
              : card.video_state === "uploading" && <span className="inline-flex items-center gap-1"><Hourglass className="size-3.5" />Video uploading</span>}
          </div>
        </button>
      </li>;
    })}
  </ul>;
}
