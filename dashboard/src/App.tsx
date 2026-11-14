import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Ambulance, ArrowRight, ChevronLeft, ClipboardList, Download, Glasses, HeartPulse, Mic, Moon, Play, Printer, Sparkles, Sun, TriangleAlert, Upload, Wifi, WifiOff, X,
} from "lucide-react";
import { setupRecorder } from "../recorder.js";
import { Board } from "./Board";
import { api, arrival, identity, inbound, live, type Health, type Session, type SessionCard } from "./data";
import { ImportDialog, PhotoDialog, RecordDialog } from "./Dialogs";
import { PatientView, type PhotoView } from "./Patient";
import { Button, Pill, useNow } from "./ui";

const idFromHash = () => {
  const id = location.hash.slice(1);
  return /^[a-f0-9-]{36}$/.test(id) ? id : null;
};

export function App() {
  const [cards, setCards] = useState<SessionCard[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(idFromHash);
  const [session, setSession] = useState<Session | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [arrived, setArrived] = useState<SessionCard | null>(null);
  const [importing, setImporting] = useState<{ attach: Session | null } | null>(null);
  const [viewing, setViewing] = useState<{ photo: PhotoView; photos: PhotoView[] } | null>(null);
  const [sampling, setSampling] = useState(false);
  const [allEarlier, setAllEarlier] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const control = useRef<{ select: (id: string | null) => void; refresh: () => Promise<void> } | null>(null);
  const recorder = useRef<{ open: () => unknown } | null>(null);
  const now = useNow(15_000);

  useEffect(() => {
    let selected = idFromHash();
    let current: Session | null = null;
    let seen: Set<string> | null = null;
    let sequence = 0;

    async function refresh() {
      const request = ++sequence;
      let list: SessionCard[];
      try {
        list = await api<SessionCard[]>("/api/sessions");
      } catch {
        if (request === sequence) setConnected(false);
        return;
      }
      if (request !== sequence) return;
      setConnected(true);
      setCards(list);
      // A capture that starts on the glasses opens by itself unless someone is reading another patient.
      const glasses = list.filter(card => card.source === "glasses");
      const fresh = seen ? glasses.find(card => !seen!.has(card.id)) : !selected && glasses.find(card => live(card));
      seen = new Set(glasses.map(card => card.id));
      if (fresh && fresh.id !== selected) {
        if ((!selected || current?.status === "created") && !document.querySelector("dialog[open]")) return select(fresh.id);
        setArrived(fresh);
      }
      if (!selected) return;
      try {
        const detail = await api<Session>(`/api/sessions/${selected}`);
        if (request !== sequence || detail.id !== selected) return;
        if (detail.id !== current?.id || detail.updated_at !== current.updated_at) {
          current = detail;
          setSession(detail);
        }
      } catch (error) {
        if (request !== sequence) return;
        setNotice((error as Error).message);
        if (!list.some(card => card.id === selected)) select(null);
      }
    }
    function select(id: string | null) {
      selected = id;
      current = null;
      setSelectedId(id);
      setSession(null);
      setViewing(null);
      setArrived(card => (card?.id === id ? null : card));
      setNotice(null);
      history.replaceState(null, "", id ? `/#${id}` : "/");
      void refresh();
    }
    control.current = { select, refresh };

    const events = new EventSource("/events");
    events.addEventListener("update", () => void refresh());
    // Some HTTPS proxies, like Cloudflare quick tunnels, hold back event streams. Poll as well.
    const poll = setInterval(() => void refresh(), 3000);
    const checkHealth = () => api<Health>("/api/health").then(setHealth, () => {});
    const healthPoll = setInterval(checkHealth, 30_000);
    const hash = () => select(idFromHash());
    window.addEventListener("hashchange", hash);
    void checkHealth();
    void refresh();
    recorder.current = setupRecorder({ api, selectSession: async (id: string) => select(id) });
    return () => {
      events.close();
      clearInterval(poll);
      clearInterval(healthPoll);
      window.removeEventListener("hashchange", hash);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("inbound-theme", dark ? "dark" : "light"); } catch { /* private mode */ }
  }, [dark]);

  const liveCount = cards?.filter(card => live(card, now)).length ?? 0;
  useEffect(() => {
    document.title = liveCount ? `(${liveCount}) Inbound · ER arrivals` : "Inbound · ER arrivals";
  }, [liveCount]);

  const select = (id: string | null) => control.current?.select(id);
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await control.current?.refresh();
    } catch (error) {
      setNotice((error as Error).message);
    }
  };
  const openSample = async () => {
    setSampling(true);
    await act(async () => select((await api<Session>("/api/sample", { method: "POST" })).id));
    setSampling(false);
  };
  const exportJson = () => act(async () => {
    const result = await api(`/api/sessions/${selectedId}/report.json`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `inbound-${selectedId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const uploadVideo = async (file: File) => {
    const data = new FormData();
    data.append("video", file);
    await api(`/api/sessions/${selectedId}/video`, { method: "POST", body: data });
    await control.current?.refresh();
  };

  // On the way: still talking, or due any minute, soonest first. The rest moves down to Earlier.
  const due = (card: SessionCard) => (live(card, now) ? 0 : arrival(card) ?? Infinity);
  const incoming = (cards ?? []).filter(card => inbound(card, now)).sort((a, b) => due(a) - due(b));
  const earlier = (cards ?? []).filter(card => !incoming.includes(card));
  const earlierShown = earlier.filter((card, index) => allEarlier || index < 8 || card.id === selectedId);
  const actions = { onRecord: () => recorder.current?.open(), onImport: () => setImporting({ attach: null }), onSample: () => void openSample(), sampling };

  return <div className="min-h-screen">
    <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur-xl dark:border-white/[0.06] dark:bg-[#060911]/75 sm:px-6">
      <button onClick={() => select(null)} className="flex items-center gap-2.5" aria-label="Inbound home">
        <Logo />
        <span className="text-[17px] font-semibold tracking-tight">Inbound</span>
      </button>
      <span className="hidden h-5 w-px bg-slate-200 dark:bg-white/10 md:block" />
      <span className="hidden text-sm font-medium text-slate-500 dark:text-slate-400 md:block">Emergency department · Arrivals</span>
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
        {session?.report && <div className="hidden items-center gap-1 lg:flex">
          <Button variant="ghost" icon={Printer} onClick={() => window.print()}>Print</Button>
          <Button variant="ghost" icon={Download} onClick={() => void exportJson()}>Export</Button>
        </div>}
        {connected === false
          ? <Pill tone="warn" icon={WifiOff}>Reconnecting</Pill>
          : <Pill tone={connected ? "ok" : "idle"} icon={Wifi} className="hidden sm:inline-flex">{connected ? "Connected" : "Connecting"}</Pill>}
        {health && (health.ai_configured
          ? <Pill tone="ok" icon={Sparkles} className="hidden sm:inline-flex">AI ready</Pill>
          : <Pill tone="warn" icon={TriangleAlert}>AI key needed</Pill>)}
        <Clock />
        <button onClick={() => setDark(!dark)} aria-label={dark ? "Use light theme" : "Use dark theme"} className="grid size-10 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-white/5">
          {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </button>
      </div>
    </header>

    <div className="lg:flex">
      {/* On a phone the board and the patient take turns; on a wide screen the board stays alongside. */}
      <aside className={clsx("no-print border-b border-slate-200/80 dark:border-white/[0.06] lg:sticky lg:top-16 lg:flex lg:h-[calc(100vh-4rem)] lg:w-[350px] lg:shrink-0 lg:flex-col lg:border-b-0 lg:border-r", selectedId && "max-lg:hidden")}>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <Label aside={liveCount > 0 && <Pill tone="live">{liveCount} live</Pill>}>Incoming</Label>
            {cards ? <Board cards={incoming} selectedId={selectedId} onSelect={select} now={now} /> : <Skeleton />}
          </section>
          {earlier.length > 0 && <section>
            <Label aside={<span className="text-xs font-semibold tabular-nums text-slate-400">{earlier.length}</span>}>Earlier</Label>
            <Board cards={earlierShown} selectedId={selectedId} onSelect={select} now={now} />
            {earlier.length > earlierShown.length || allEarlier
              ? <button onClick={() => setAllEarlier(!allEarlier)} className="mt-2 w-full rounded-xl py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-white/5">
                {allEarlier ? "Show fewer" : `Show all ${earlier.length}`}
              </button>
              : null}
          </section>}
        </div>
        <div className="grid grid-cols-3 gap-2 border-t border-slate-200/80 p-3 dark:border-white/[0.06]">
          <RailButton icon={Mic} onClick={actions.onRecord}>Record</RailButton>
          <RailButton icon={Upload} onClick={actions.onImport}>Import</RailButton>
          <RailButton icon={Play} onClick={actions.onSample} disabled={sampling}>Sample</RailButton>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <div className="mx-auto max-w-[1500px] space-y-4">
          {notice && <div role="alert" className="no-print flex items-center gap-3 rounded-xl bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-700 ring-1 ring-rose-500/25 dark:text-rose-200">
            <TriangleAlert className="size-4 shrink-0" />{notice}
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="ml-auto grid size-7 place-items-center rounded-md hover:bg-rose-500/15"><X className="size-4" /></button>
          </div>}
          {arrived && <Arrived card={arrived} onView={() => select(arrived.id)} onDismiss={() => setArrived(null)} />}
          {selectedId && <button onClick={() => select(null)} className="no-print -ml-2 flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-white/5 lg:hidden">
            <ChevronLeft className="size-4" />All patients
          </button>}
          {selectedId
            ? session
              ? <PatientView key={session.id} session={session} now={now}
                onPhoto={(photo, photos) => setViewing({ photo, photos })}
                onRetry={() => act(() => api(`/api/sessions/${session.id}/process`, { method: "POST" }))}
                onAttach={() => setImporting({ attach: session })}
                onUploadVideo={uploadVideo} />
              : <Loading />
            : <Welcome {...actions} waiting={connected !== false} />}
        </div>
      </main>
    </div>

    {importing && <ImportDialog attach={importing.attach} onClose={() => setImporting(null)} onDone={id => select(id)} />}
    {viewing && session && <PhotoDialog session={session} photos={viewing.photos} start={viewing.photo.id} onClose={() => setViewing(null)} />}
    <RecordDialog />
  </div>;
}

function Logo() {
  return <span className="grid size-8 place-items-center rounded-[10px] bg-gradient-to-br from-emerald-300 to-teal-600 text-emerald-950 shadow-lg shadow-emerald-500/25">
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 12.5h4l2.2-5.5 4.3 10.5 2.3-5h6.2" />
    </svg>
  </span>;
}

function Clock() {
  const now = useNow(1000);
  return <time className="hidden rounded-xl px-2 text-sm font-semibold tabular-nums text-slate-600 dark:text-slate-300 sm:block">
    {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
  </time>;
}

function Label({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return <div className="mb-2.5 flex h-7 items-center justify-between px-1">
    <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{children}</h2>
    {aside}
  </div>;
}

function RailButton({ icon: Icon, children, onClick, disabled }: { icon: typeof Mic; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="flex flex-col items-center gap-1 rounded-xl py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-200/60 disabled:opacity-45 dark:text-slate-300 dark:hover:bg-white/5">
    <Icon className="size-[18px]" strokeWidth={2.25} />{children}
  </button>;
}

function Skeleton() {
  return <div className="space-y-2">{[0, 1].map(index => <div key={index} className="h-[118px] animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]" />)}</div>;
}

function Loading() {
  return <div className="space-y-4">
    <div className="h-[150px] animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]" />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map(index => <div key={index} className="h-[132px] animate-pulse rounded-2xl bg-slate-200/70 dark:bg-white/[0.04]" />)}</div>
  </div>;
}

function Arrived({ card, onView, onDismiss }: { card: SessionCard; onView: () => void; onDismiss: () => void }) {
  const { who, what } = identity(card, live(card));
  return <div className="no-print flex flex-wrap items-center gap-3 rounded-2xl bg-rose-500/10 px-4 py-3 ring-1 ring-rose-500/30 dark:bg-rose-500/12 dark:ring-rose-400/35">
    <span className="grid size-9 place-items-center rounded-xl bg-rose-500 text-white shadow-lg shadow-rose-500/30"><Ambulance className="size-5" /></span>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-semibold text-rose-700 dark:text-rose-200">New patient from the glasses</div>
      <div className="truncate text-sm text-slate-600 dark:text-slate-300">{who} · {what}</div>
    </div>
    <Button variant="primary" icon={ArrowRight} onClick={onView}>Open</Button>
    <button onClick={onDismiss} aria-label="Dismiss" className="grid size-9 place-items-center rounded-lg text-slate-500 hover:bg-rose-500/10"><X className="size-4" /></button>
  </div>;
}

const steps = [
  { icon: Glasses, title: "The medic says “start”", text: "Voice, vitals and injury photos stream here from the glasses while hands stay on the patient." },
  { icon: HeartPulse, title: "Every vital is read back", text: "The glasses repeat each value out loud and ask again when two numbers conflict, so what you see is confirmed." },
  { icon: ClipboardList, title: "Handover before arrival", text: "An IMIST-AMBO handover with NEWS2 colour cues, a source for every statement, and what to ask the crew." },
];

function Welcome({ onRecord, onImport, onSample, sampling, waiting }: { onRecord: () => void; onImport: () => void; onSample: () => void; sampling: boolean; waiting: boolean }) {
  return <div className="space-y-4">
    <section className="relative overflow-hidden rounded-3xl bg-white p-8 ring-1 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/[0.08] sm:p-12">
      <Radar />
      <div className="relative max-w-2xl">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-400">Pre-arrival handover</div>
        <h1 className="mt-4 text-[44px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-6xl">Know the patient<br />before the doors open.</h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600 dark:text-slate-300">
          Paramedics talk, take photos and call out vitals hands-free on smart glasses. Inbound turns it into a live feed and a structured handover while the ambulance is still on the road.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button variant="primary" icon={Play} onClick={onSample} disabled={sampling} className="h-12 px-5 text-[15px]">{sampling ? "Opening…" : "Open a sample patient"}</Button>
          <Button icon={Mic} onClick={onRecord} className="h-12 px-5 text-[15px]">Record on this Mac</Button>
          <Button variant="ghost" icon={Upload} onClick={onImport} className="h-12 px-5 text-[15px]">Import a recording</Button>
        </div>
        <div className={clsx("mt-8 flex items-center gap-2.5 text-sm", waiting ? "text-slate-500 dark:text-slate-400" : "text-amber-700 dark:text-amber-300")}>
          <span className="relative flex size-2.5">
            {waiting && <span className="absolute inset-0 rounded-full bg-emerald-500 motion-safe:animate-ring" />}
            <span className={clsx("relative size-2.5 rounded-full", waiting ? "bg-emerald-500" : "bg-amber-500")} />
          </span>
          {waiting ? "Waiting for ambulances. A patient opens here the moment a medic says “start”." : "Can’t reach the Inbound server. Retrying…"}
        </div>
      </div>
    </section>
    <div className="grid gap-4 md:grid-cols-3">
      {steps.map((step, index) => <section key={step.title} className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-white/[0.03] dark:ring-white/[0.08]">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-300"><step.icon className="size-5" /></span>
          <span className="text-xs font-semibold tabular-nums text-slate-400">0{index + 1}</span>
        </div>
        <h2 className="mt-4 text-base font-semibold">{step.title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">{step.text}</p>
      </section>)}
    </div>
  </div>;
}

// Rings travelling out from the ambulance: the board is listening.
function Radar() {
  return <div aria-hidden className="pointer-events-none absolute -right-24 top-1/2 hidden size-[460px] -translate-y-1/2 lg:block">
    {[0, 1, 2].map(ring => <span key={ring} className="absolute inset-0 rounded-full border border-emerald-500/30 motion-safe:animate-[radar_4.5s_ease-out_infinite]" style={{ animationDelay: `${ring * 1.5}s` }} />)}
    <span className="absolute inset-[30%] rounded-full bg-emerald-500/10 blur-2xl" />
    <span className="absolute left-1/2 top-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-3xl bg-gradient-to-br from-emerald-300 to-teal-600 text-emerald-950 shadow-2xl shadow-emerald-500/30">
      <Ambulance className="size-10" strokeWidth={1.75} />
    </span>
  </div>;
}
