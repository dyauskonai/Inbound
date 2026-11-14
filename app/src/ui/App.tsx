import { useEffect, useState } from "react";
import type { Command, State } from "../shared/channels";
import { canStartCapture } from "../shared/commands";

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export function App() {
  const [state, setState] = useState<State | null>(null);
  const [server, setServer] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const off = mentra.on("state", setState);
    mentra.request("getState", {}, {timeout: 10000}).then(setState).catch(() => setError("Open Inbound inside the Mentra app to connect to your glasses."));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { off(); clearInterval(timer); };
  }, []);
  const savedAddress = state?.server ?? "";
  useEffect(() => setServer(savedAddress), [savedAddress]);
  const recording = state?.phase === "recording";
  const unconfirmed = state?.phase === "start_unconfirmed";
  const ready = state && canStartCapture(state.phase);
  const send = (command: Command) => mentra.send("command", {command});
  const copyLogs = async () => {
    try {
      await mentra.request("copyDiagnostics", {}, {timeout: 5000});
      setCopied("Logs copied.");
    } catch {
      setCopied("Select and copy the logs below.");
    }
  };
  return <main>
    <header><span className="brand">inbound<span>↘</span></span><span className="badge">CAPTURE</span></header>
    <p className="eyebrow">FROM THE FIELD. WITH CONTEXT.</p>
    <h1>Stay present.<br/><em>Keep the details.</em></h1>
    <div className="connection"><span className={state?.connected && state.camera ? "dot online" : "dot"}/>{state?.connected && state.camera ? "Camera glasses connected" : "Connect Mentra Live in Mentra"}<span>{state?.battery == null ? "" : `${state.battery}%`}</span></div>
    <section className={`capture ${recording ? "recording" : ""}`}>
      <div className="capture-label">{recording ? "● RECORDING" : (state?.phase || "connecting").replaceAll("_", " ").toUpperCase()}</div>
      <div className="clock">{recording && state?.capture ? time(Math.max(0, (now - state.capture.startedAt)/1000)) : "Ready when you are."}</div>
      <p>{state?.message || "Connecting to the Mentra app…"}</p>
      {ready && state.captureMode === "device" && <small>Stop saves the clip, then the glasses upload it to your Mac over Wi-Fi.</small>}
      {ready && <button className="primary" disabled={state.busy || !state.server} onClick={() => send("start")}>● Start recording</button>}
      {recording && <div className="controls"><button className="primary" disabled={state.busy} onClick={() => send("snap")}>＋ Snap</button><button onClick={() => send("stop")}>■ Stop</button></div>}
      {state?.phase === "starting" && <button disabled={state.stopPending} onClick={() => send("stop")}>{state.stopPending ? "Stop requested" : "■ Stop"}</button>}
      {state?.capture && ["stopping", "waiting_upload", "processing", "awaiting_key"].includes(state.phase) && <button disabled={state.busy} onClick={() => mentra.send("retry", {})}>Retry / check upload</button>}
      {state?.phase === "waiting_upload" && !state.busy && <button onClick={() => mentra.send("newCapture", {})}>Camera is idle · Start a new capture</button>}
      {state?.capture?.live && ["start_unconfirmed", "waiting_upload", "processing", "awaiting_key", "complete"].includes(state.phase) && <button onClick={() => mentra.send("stopPublisher", {})}>Stop glasses</button>}
      {(unconfirmed || state?.phase === "stopping") && state.capture && !state.busy && <div className="controls">
        <button onClick={() => mentra.send("confirmStoppedOnGlasses", {})}>I stopped it on the glasses</button>
        {unconfirmed && <button onClick={() => mentra.send("resetUnconfirmedStart", {})}>Camera is idle · try again</button>}
      </div>}
      <div className="voice">{state?.voice || "Loading voice controls"}</div>
      {state?.heard && <small>{state.heardFinal ? "Heard" : "Listening"}: “{state.heard}”</small>}
      {state?.voiceCommand && <small role="status">{state.voiceCommand}</small>}
    </section>
    <div className="commands"><span><b>“Start”</b>Record</span><span><b>“Snap”</b>Mark a moment</span><span><b>“Stop”</b>Prepare report</span></div>
    {(error || state?.error) && <p className="error" role="alert">{error || state?.error}</p>}
    {state?.capture && <section className="moments"><div className="section-head"><h2>Marked moments</h2><span>{state.capture.bookmarks.length}</span></div>{state.capture.bookmarks.map(mark => <div key={mark.id} className="moment"><span>↗ {mark.label}</span><time>{time(mark.seconds)}</time></div>)}<p className="fine">The Mac saves a still and clip from each mark after the video uploads.</p><button className="text-button" onClick={() => mentra.send("report", {})}>Open report on the Mac server ↗</button></section>}
    <details open={!state?.server}><summary>Connection settings <span>{state?.online ? "Mac connected" : "Set up"}</span></summary><label htmlFor="server">Mac server address</label><input id="server" type="url" value={server} onChange={event=>setServer(event.target.value)} placeholder="http://192.168.1.20:8000" autoCapitalize="none" autoCorrect="off"/><button disabled={!state || state.busy || (!!state.capture && !ready)} onClick={() => mentra.send("connect", {server})}>Connect to Mac</button>{state?.defaultServer && server !== state.defaultServer && <button className="text-button" onClick={() => setServer(state.defaultServer)}>Use this build’s Mac address</button>}<button className="text-button" disabled={!state || state.busy} onClick={() => mentra.send("wifi", {})}>Set up glasses Wi-Fi ↗</button><p className="fine">Keep the Mac, iPhone, and glasses on the same reachable network.</p></details>
    {state && <details className="diagnostics"><summary>Capture diagnostics</summary><button className="text-button" onClick={copyLogs}>Copy logs</button><span className="fine" role="status">{copied}</span><pre tabIndex={0}>{state.diagnostics.join("\n")}</pre></details>}
    <footer>Immerse the Bay · Training prototype<br/>Use fictional scenarios and consenting volunteers.</footer>
  </main>;
}
