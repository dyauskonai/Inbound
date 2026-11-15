import clsx from "clsx";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";

export type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;
export type Tone = "critical" | "warn" | "ok" | "info" | "live" | "idle";

// Color always comes with an icon and words; never the only signal.
export const toneText: Record<Tone, string> = {
  critical: "text-rose-700 dark:text-rose-300",
  warn: "text-amber-700 dark:text-amber-300",
  ok: "text-emerald-700 dark:text-emerald-300",
  info: "text-sky-700 dark:text-sky-300",
  live: "text-rose-700 dark:text-rose-300",
  idle: "text-slate-600 dark:text-slate-300",
};
export const toneSoft: Record<Tone, string> = {
  critical: "bg-rose-500/10 ring-rose-500/30 dark:bg-rose-500/12 dark:ring-rose-400/35",
  warn: "bg-amber-500/12 ring-amber-500/30 dark:bg-amber-400/10 dark:ring-amber-400/30",
  ok: "bg-emerald-500/10 ring-emerald-500/25 dark:bg-emerald-400/10 dark:ring-emerald-400/25",
  info: "bg-sky-500/10 ring-sky-500/25 dark:bg-sky-400/10 dark:ring-sky-400/25",
  live: "bg-rose-500/10 ring-rose-500/30 dark:bg-rose-500/12 dark:ring-rose-400/35",
  idle: "bg-slate-500/8 ring-slate-300 dark:bg-white/5 dark:ring-white/10",
};

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={clsx("rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/90 dark:bg-white/[0.035] dark:shadow-none dark:ring-white/[0.08] dark:backdrop-blur-sm print:shadow-none print:ring-slate-300", className)}>{children}</section>;
}

export function Heading({ icon: Icon, children, aside }: { icon?: Icon; children: ReactNode; aside?: ReactNode }) {
  return <div className="mb-3.5 flex items-center gap-2">
    {Icon && <Icon className="size-4 text-slate-400" strokeWidth={2.25} />}
    <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{children}</h2>
    {aside && <div className="ml-auto">{aside}</div>}
  </div>;
}

export function Pill({ tone, icon: Icon, children, className }: { tone: Tone; icon?: Icon; children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold ring-1", toneSoft[tone], toneText[tone], className)}>
    {tone === "live" && <span className="relative flex size-2"><span className="absolute inset-0 rounded-full bg-rose-500 motion-safe:animate-ring" /><span className="relative size-2 rounded-full bg-rose-500" /></span>}
    {Icon && <Icon className="size-3.5" strokeWidth={2.5} />}
    {children}
  </span>;
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export const buttonClass = (variant: Variant = "secondary") => clsx(
  "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45",
  variant === "primary" && "bg-emerald-500 text-emerald-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400",
  variant === "secondary" && "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-white/[0.06] dark:text-slate-100 dark:ring-white/10 dark:hover:bg-white/10",
  variant === "ghost" && "text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-white/5",
  variant === "danger" && "bg-rose-600 text-white shadow-lg shadow-rose-600/25 hover:bg-rose-500",
);

export function Button({ children, icon: Icon, onClick, disabled, variant, className, title, type = "button" }: {
  children: ReactNode; icon?: Icon; onClick?: () => void; disabled?: boolean; variant?: Variant; className?: string; title?: string; type?: "button" | "submit";
}) {
  return <button type={type} title={title} disabled={disabled} onClick={onClick} className={clsx(buttonClass(variant), className)}>
    {Icon && <Icon className="size-4" strokeWidth={2.25} />}{children}
  </button>;
}

/** The current time, refreshed every `ms` milliseconds. */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
