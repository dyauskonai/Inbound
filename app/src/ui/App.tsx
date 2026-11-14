import { useEffect, useState } from "react";
import clsx from "clsx";
import { ChevronDown, ClipboardCopy, Laptop, Settings2, Video, Volume2, Wifi } from "lucide-react";
import type { Command, State } from "../shared/channels";
import { ActionBar, Banner, Card, DeliveredCard, Eyebrow, HeardPanel, Header, PhotoStrip, StatusHero, VitalsGrid } from "./parts";

// Voice first: the phone is a glanceable status screen with big, glove-friendly backups.
export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const off = mentra.on("state", setState);
    mentra.request("getState", {}, {timeout: 10000}).then(setState).catch(() => setError("Open Inbound inside the Mentra app to connect to your glasses."));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { off(); clearInterval(timer); };
  }, []);
  const recording = state?.phase === "recording";
  const send = (command: Command) => mentra.send("command", {command});
  const problem = error || state?.error;
  return <main className="mx-auto max-w-md space-y-3.5 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-44">
    <Header state={state} />
    {problem && <Banner>{problem}</Banner>}
    <StatusHero state={state} now={now} />
    {state && recording && <VitalsGrid vitals={state.vitals} live />}
    {state && !recording && state.delivered && <DeliveredCard delivered={state.delivered} onOpen={() => mentra.send("report", {})} />}
    {state && <HeardPanel state={state} />}
    {state && recording && state.capture && <PhotoStrip photos={state.capture.photos} />}
    {state && !recording && state.vitals.length > 0 && <VitalsGrid vitals={state.vitals} live={false} />}
    {state && <Setup state={state} />}
    <footer className="px-2 pt-2 text-center text-xs leading-relaxed text-slate-500">Immerse the Bay · Training prototype<br />Use fictional scenarios and consenting volunteers.</footer>
    <ActionBar state={state} onCommand={send} />
  </main>;
}

function Setup({ state }: { state: State }) {
  const [server, setServer] = useState(state.server);
  const [copied, setCopied] = useState("");
  useEffect(() => setServer(state.server), [state.server]);
  const copyLogs = async () => {
    try {
      await mentra.request("copyDiagnostics", {}, {timeout: 5000});
      setCopied("Logs copied.");
    } catch {
      setCopied("Select and copy the logs below.");
    }
  };
  const blocked = state.busy || state.phase === "recording";
  const secondary = "h-14 w-full rounded-2xl bg-slate-100 px-4 text-[15px] font-semibold ring-1 ring-slate-200 transition active:scale-[0.99] disabled:opacity-40 dark:bg-white/5 dark:ring-white/10";
  return <details className="group" open={!state.online}>
    <summary className="flex h-14 cursor-pointer list-none items-center gap-2 rounded-2xl px-2 text-[15px] font-semibold text-slate-600 dark:text-slate-300 [&::-webkit-details-marker]:hidden">
      <Settings2 className="size-5" />Setup &amp; checks
      <span className={clsx("ml-auto text-sm font-medium", state.online ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>{state.online ? "Connected" : "Needs setup"}</span>
      <ChevronDown className="size-5 transition group-open:rotate-180" />
    </summary>
    <div className="mt-2 space-y-3">
      <Card className="space-y-3">
        <Eyebrow icon={Laptop}>Inbound server</Eyebrow>
        <input aria-label="Server address" type="url" value={server} onChange={event => setServer(event.target.value)} placeholder="http://192.168.1.20:8000" autoCapitalize="none" autoCorrect="off"
          className="h-14 w-full rounded-2xl bg-slate-50 px-4 font-mono text-[15px] ring-1 ring-slate-300 outline-none focus:ring-2 focus:ring-emerald-500 dark:bg-black/30 dark:ring-white/15" />
        <button disabled={blocked} onClick={() => mentra.send("connect", {server})} className={secondary}>Connect</button>
        {state.defaultServer && server !== state.defaultServer && <button className="text-sm font-semibold text-emerald-700 dark:text-emerald-300" onClick={() => setServer(state.defaultServer)}>Use this build’s address</button>}
        <p className="text-sm leading-snug text-slate-500 dark:text-slate-400">The phone and the server must reach each other. Audio, photos, and vitals go from the phone to the server.</p>
      </Card>
      <Card className="space-y-3">
        <Eyebrow icon={Video}>Glasses video</Eyebrow>
        <button role="switch" aria-checked={state.videoEnabled} disabled={blocked} onClick={() => mentra.send("video", {enabled: !state.videoEnabled})} className="flex w-full items-center gap-3 text-left disabled:opacity-40">
          <span className="flex-1 text-base font-semibold">Record video on the glasses</span>
          <span className={clsx("relative h-8 w-14 rounded-full transition", state.videoEnabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-white/15")}>
            <span className={clsx("absolute top-1 size-6 rounded-full bg-white shadow transition-all", state.videoEnabled ? "left-7" : "left-1")} />
          </span>
        </button>
        <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400"><Wifi className="size-4" />{state.wifi ? `Glasses Wi-Fi: ${state.glassesNetwork || "connected"}` : "Glasses Wi-Fi: not connected"}</div>
        <p className="text-sm leading-snug text-slate-500 dark:text-slate-400">{state.videoUploadBase ? "Video uploads over the internet through the server’s secure tunnel, so the glasses’ Wi-Fi only needs internet." : "Video uploads over the glasses’ own Wi-Fi to the server."}</p>
        <div className="grid grid-cols-2 gap-2">
          <button disabled={state.busy} onClick={() => mentra.send("wifi", {})} className={secondary}>Set up Wi-Fi</button>
          <button disabled={blocked} onClick={() => mentra.send("checkUpload", {})} className={secondary}>Test upload</button>
        </div>
        {state.uploadCheck && <p role="status" className="text-sm font-medium leading-snug">{state.uploadCheck}</p>}
      </Card>
      <Card className="space-y-3">
        <Eyebrow icon={Volume2}>Glasses speaker</Eyebrow>
        <p className="text-sm leading-snug text-slate-500 dark:text-slate-400">The glasses ask you to repeat a vital when two numbers conflict, and read back what they log.</p>
        <button disabled={blocked} onClick={() => mentra.send("checkSpeaker", {})} className={secondary}>Test glasses speaker</button>
      </Card>
      <Card className="space-y-3">
        <Eyebrow icon={ClipboardCopy}>Diagnostics</Eyebrow>
        <div className="flex items-center gap-3">
          <button onClick={copyLogs} className={clsx(secondary, "w-auto")}>Copy logs</button>
          <span role="status" className="text-sm text-slate-500 dark:text-slate-400">{copied}</span>
        </div>
        <pre tabIndex={0} className="max-h-56 overflow-auto rounded-2xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600 ring-1 ring-slate-200 dark:bg-black/30 dark:text-slate-400 dark:ring-white/10">{state.diagnostics.join("\n")}</pre>
      </Card>
    </div>
  </details>;
}
