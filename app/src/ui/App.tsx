import { useEffect, useState } from "react";
import type { Command, State } from "../shared/channels";

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
export function App() {
  const [state, setState] = useState<State | null>(null);
  const [server, setServer] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const off = mentra.on("state", setState);
    mentra.request("getState", {}, {timeout: 10000}).then((next) => { setState(next); setServer(next.server); }).catch(() => setError("Open Inbound inside the Mentra app to connect to your glasses."));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { off(); clearInterval(timer); };
  }, []);
  const recording = state?.phase === "recording";
  const ready = state && ["ready", "complete"].includes(state.phase);
  const send = (command: Command) => mentra.send("command", {command});
  return <main>
    <header><span className="brand">inbound<span>↘</span></span><span className="badge">CAPTURE</span></header>
    <p className="eyebrow">FROM THE FIELD. WITH CONTEXT.</p>
    <h1>Stay present.<br/><em>Keep the details.</em></h1>
    <div className="connection"><span className={state?.camera ? "dot online" : "dot"}/>{state?.camera ? "Camera glasses connected" : "Connect Mentra Live in Mentra"}<span>{state?.battery == null ? "" : `${state.battery}%`}</span></div>
    <section className={`capture ${recording ? "recording" : ""}`}>
      <div className="capture-label">{recording ? "● RECORDING" : (state?.phase || "connecting").replaceAll("_", " ").toUpperCase()}</div>
      <div className="clock">{recording && state?.capture ? time(Math.max(0, (now - state.capture.startedAt)/1000)) : "Ready when you are."}</div>
      <p>{state?.message || "Connecting to the Mentra app…"}</p>
      {ready && <button className="primary" disabled={state.busy || !state.server} onClick={() => send("start")}>● Start recording</button>}
      {recording && <div className="controls"><button className="primary" disabled={state.busy} onClick={() => send("snap")}>＋ Snap</button><button onClick={() => send("stop")}>■ Stop</button></div>}
      {state?.capture && !recording && !ready && <button disabled={state.busy} onClick={() => mentra.send("retry", {})}>Retry / check upload</button>}
      {state?.phase === "starting" && state.capture && !state.capture.recordingId && !state.busy &&
        <button onClick={() => mentra.send("resetUnconfirmedStart", {})}>Glasses stopped · reset capture</button>}
      <div className="voice">{state?.voice || "Loading voice controls"}</div>
      {state?.heard && <small>Heard: “{state.heard}”</small>}
    </section>
    <div className="commands"><span><b>“Start”</b>Record</span><span><b>“Snap”</b>Mark a moment</span><span><b>“Stop”</b>Prepare report</span></div>
    {(error || state?.error) && <p className="error" role="alert">{error || state?.error}</p>}
    {state?.capture && <section className="moments"><div className="section-head"><h2>Marked moments</h2><span>{state.capture.bookmarks.length}</span></div>{state.capture.bookmarks.map(mark => <div key={mark.id} className="moment"><span>↗ {mark.label}</span><time>{time(mark.seconds)}</time></div>)}<p className="fine">Each mark becomes a still and a short clip after upload. Voice marks use the time the command is recognized.</p><button className="text-button" onClick={() => mentra.send("report", {})}>Open report on the Mac server ↗</button></section>}
    <details open={!state?.server}><summary>Connection settings <span>{state?.online ? "Mac connected" : "Set up"}</span></summary><label htmlFor="server">Mac server address</label><input id="server" type="url" value={server} onChange={event=>setServer(event.target.value)} placeholder="http://192.168.1.20:8000" autoCapitalize="none" autoCorrect="off"/><button disabled={!state || state.busy || (!!state.capture && !ready)} onClick={() => mentra.send("connect", {server})}>Connect to Mac</button><button className="text-button" disabled={!state || state.busy} onClick={() => mentra.send("wifi", {})}>Set up glasses Wi-Fi ↗</button><p className="fine">Keep the Mac, iPhone, and glasses on the same reachable network.</p></details>
    <footer>Immerse the Bay · Training prototype<br/>Use fictional scenarios and consenting volunteers.</footer>
  </main>;
}
