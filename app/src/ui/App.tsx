import { useEffect, useState } from "react";
import type { Command, State } from "../shared/channels";

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const photoStatus = { taking: "Taking…", uploading: "Sending…", saved: "On the Mac", failed: "Failed", from_video: "From the video" };
const videoStatus = { starting: "Starting video on the glasses…", recording: "● Video recording on the glasses", stopping: "Stopping video…", uploading: "Glasses uploading video over Wi-Fi…", failed: "Video unavailable" };
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
      <div className="capture-label">{recording ? "● RECORDING" : state ? "READY" : "CONNECTING"}</div>
      <div className="clock">{recording && state?.capture ? time(Math.max(0, (now - state.capture.startedAt)/1000)) : "Ready when you are."}</div>
      <p>{state?.message || "Connecting to the Mentra app…"}</p>
      {recording && !state.audio && now - (state.capture?.startedAt ?? now) > 5000 && <small>No mic audio yet. Transcript lines from the phone will still reach the Mac.</small>}
      {recording && state.capture?.video && <small>{videoStatus[state.capture.video.state]}{state.capture.video.state === "failed" && state.capture.video.detail ? `. ${state.capture.video.detail}` : ""}</small>}
      {state && !recording && <button className="primary" disabled={!state.server} onClick={() => send("start")}>● Start recording</button>}
      {state && !recording && <label className="fine"><input type="checkbox" checked={state.videoEnabled} onChange={event => mentra.send("video", {enabled: event.target.checked})}/> Also record video on the glasses {state.videoEnabled && !state.wifi && "· the glasses need Wi-Fi to upload it"}</label>}
      {recording && <div className="controls"><button className="primary" onClick={() => send("snap")}>＋ Snap photo</button><button onClick={() => send("stop")}>■ Stop</button></div>}
      {!!state?.pending && <small>{state.pending} upload{state.pending === 1 ? "" : "s"} waiting · {Math.ceil(state.pendingBytes / 1024)} KB</small>}
      {state?.delivered && !recording && <small role="status">Last capture: {state.delivered.progress}{state.delivered.video === "ready" ? " Video on the dashboard." : state.delivered.video === "uploading" ? " Video uploading from the glasses…" : ""}</small>}
      <div className="voice">{state?.voice || "Loading voice controls"}</div>
      {!recording && state?.voice === "Voice commands ready" && <small>The phone listens for “start” on its own. Nothing is recorded or sent until you start.</small>}
      {state?.heard && <small>{recording ? state.heardFinal ? "Heard" : "Listening" : "Heard on the phone, not sent"}: “{state.heard}”</small>}
      {state?.voiceCommand && <small role="status">{state.voiceCommand}</small>}
    </section>
    <div className="commands"><span><b>“Start”</b>Record</span><span><b>“Snap”</b>Take a photo</span><span><b>“Stop”</b>Send report</span></div>
    {(error || state?.error) && <p className="error" role="alert">{error || state?.error}</p>}
    {state?.capture && <section className="moments"><div className="section-head"><h2>Photos</h2><span>{state.capture.photos.length}</span></div>{state.capture.photos.map(photo => <div key={photo.seq} className="moment"><span>↗ Photo {photo.seq} · {photoStatus[photo.status]}</span><time>{time(photo.seconds)}</time></div>)}<p className="fine">Photos, audio, and transcript lines appear on the Mac dashboard as they arrive.</p></section>}
    {(state?.capture || state?.delivered) && <button className="text-button" onClick={() => mentra.send("report", {})}>Open on the Mac dashboard ↗</button>}
    <details open={!state?.online}><summary>Connection settings <span>{state?.online ? "Mac connected" : "Set up"}</span></summary><label htmlFor="server">Mac server address</label><input id="server" type="url" value={server} onChange={event=>setServer(event.target.value)} placeholder="http://192.168.1.20:8000" autoCapitalize="none" autoCorrect="off"/><button disabled={!state || state.busy} onClick={() => mentra.send("connect", {server})}>Connect to Mac</button>{state?.defaultServer && server !== state.defaultServer && <button className="text-button" onClick={() => setServer(state.defaultServer)}>Use this build’s Mac address</button>}<p className="fine">The phone and Mac must reach each other. Audio and photos need only Bluetooth from the glasses to the phone. {state?.videoUploadBase ? "The glasses’ video uploads over the internet through the server’s secure tunnel, so their Wi-Fi only needs internet" : "The glasses’ video uploads over their own Wi-Fi, so they must be on a network that reaches the server"}: {state?.wifi ? `connected${state.glassesNetwork ? ` (${state.glassesNetwork})` : ""}.` : "not connected."}</p><button className="text-button" disabled={!state || state.busy} onClick={() => mentra.send("wifi", {})}>Set up glasses Wi-Fi ↗</button></details>
    {state && <details className="diagnostics"><summary>Capture diagnostics</summary><button className="text-button" onClick={copyLogs}>Copy logs</button><span className="fine" role="status">{copied}</span><pre tabIndex={0}>{state.diagnostics.join("\n")}</pre></details>}
    <footer>Immerse the Bay · Training prototype<br/>Use fictional scenarios and consenting volunteers.</footer>
  </main>;
}
