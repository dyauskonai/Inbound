import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { CheckCheck, ClipboardCheck, Hourglass, LoaderCircle, MessagesSquare, Mic, Send, Sparkles, Square } from "lucide-react";
import { api, mediaUrl, type Session } from "./data";
import { fieldLabels, type PhotoView } from "./Patient";
import { vitalKinds } from "./vitals";
import { Button, Heading, Panel } from "./ui";

// Dictation uses the browser's own speech recognition, which Chrome, Edge, and Safari have.
interface Dictation {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onaudiostart: (() => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
const speech = window as unknown as { SpeechRecognition?: new () => Dictation; webkitSpeechRecognition?: new () => Dictation };
const Dictation = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
// Browsers allow the microphone only on a secure page. On this Mac, localhost counts as one.
const secureAddress = () => `${location.protocol}//localhost:${location.port}${location.pathname}${location.hash}`;

// A dictated message that ends with "send" goes straight to the medic: "Any allergies? Send." The server's
// transcription adds punctuation, so "send" can carry a question mark, and "send it" or "send that" work too.
const SEND = /^(.*?)[\s,;:–—-]*\bsend(?:\s+(?:it|that|this|now|(?:the\s+)?message))?[\s.!?"'”’]*$/i;
// "…and send it" or "can you send it" asks the medic for something, so it stays in the box to finish.
const MID_SENTENCE = /\b(?:and|or|to|please|then|i|you|he|she|we|they|can|could|would|will|should|did|do|does|not|don['’]t|can['’]t|won['’]t)$/i;

/** The message to send if the doctor ended with "send": "" when "send" was all they said. */
function spokenSend(text: string): string | null {
  const spoken = SEND.exec(text);
  if (!spoken) return null;
  const message = spoken[1].trim();
  if (MID_SENTENCE.test(message)) return null;
  if (!message) return "";
  // The question mark often lands after "send": "Any allergies, send?"
  const asked = text.slice(spoken[1].length).includes("?") && !/[.?!]$/.test(message);
  return message[0].toUpperCase() + message.slice(1) + (asked ? "?" : "");
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// What the report is missing, as questions the glasses can read out.
const questions: Record<string, [string, string]> = {
  allergies: ["Allergies?", "Does the patient have any allergies?"],
  medications: ["Medications?", "What medications is the patient on?"],
  consciousness: ["Consciousness?", "What is the patient’s level of consciousness now?"],
  blood_pressure: ["Blood pressure?", "What is the latest blood pressure?"],
  heart_rate: ["Heart rate?", "What is the heart rate now?"],
  spo2: ["SpO₂?", "What is the oxygen saturation?"],
  respiratory_rate: ["Resp. rate?", "What is the respiratory rate?"],
  patient_age: ["Age?", "How old is the patient?"],
  mechanism: ["What happened?", "What happened to the patient?"],
  eta_minutes: ["ETA?", "What is your ETA?"],
};

function quickAsks(session: Session): [string, string][] {
  const handoff = session.report?.handoff;
  const injury = handoff?.injuries[0]?.toLowerCase();
  const photo: [string, string] = [injury ? `Closer photo of the ${injury}` : "Closer photo of the injury",
    `Can you send a closer photo of ${injury ? `the ${injury}` : "the injury"}? Say snap when you’re ready.`];
  const missing = (handoff?.missing_fields ?? []).map(field => questions[field]).filter(Boolean);
  const vitals: [string, string] = ["Updated vitals?", "Can you give me an updated set of vitals?"];
  return [photo, ...missing, vitals].slice(0, 5);
}

// The ER asks the medic for what the handover left out. The glasses read each message aloud,
// and the medic's spoken answer, with a photo if they say "snap", comes back here.
export function CrewMessages({ session, isLive, onPhoto, onSend }: {
  session: Session; isLive: boolean; onPhoto: (photo: PhotoView) => void; onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [insecure, setInsecure] = useState(false);
  // Stops whichever kind of dictation is running.
  const stopDictation = useRef<(() => void) | null>(null);
  // Once the browser's recognizer has refused, go straight to recording.
  const recordOnly = useRef(!Dictation);
  const said = useRef("");
  useEffect(() => () => stopDictation.current?.(), []);
  const messages = session.messages ?? [];
  const send = async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim());
      setDraft("");
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setSending(false);
    }
  };
  const dictated = (text: string) => {
    const message = spokenSend(text);
    setDraft(message ?? text);
    if (message) void send(message);
  };

  // The browser's own recognizer: the words fill the box as they're heard. It listens on through short
  // pauses, so a beat before "send" doesn't cut it off, and stops as soon as it hears "send". Safari
  // refuses it without asking when macOS Dictation is off, and then the server transcribes instead.
  const recognize = (typed: string) => {
    const listener = new Dictation!();
    let refused = false;
    let opened = false;
    let pause: ReturnType<typeof setTimeout> | undefined;
    const stopAfter = (ms: number) => {
      clearTimeout(pause);
      pause = setTimeout(() => listener.stop(), ms);
    };
    listener.lang = "en-US";
    listener.interimResults = true;
    listener.continuous = true;
    listener.onresult = event => {
      const heard = Array.from(event.results, result => result[0].transcript).join(" ").replace(/\s+/g, " ").trim();
      said.current = [typed, heard].filter(Boolean).join(" ");
      setDraft(said.current);
      if (event.results[event.results.length - 1].isFinal && spokenSend(said.current) !== null) listener.stop();
      else stopAfter(1500);
    };
    listener.onerror = event => {
      if (["not-allowed", "service-not-allowed", "network", "audio-capture"].includes(event.error)) {
        refused = true;
        clearTimeout(pause);
        stopDictation.current = null;
        recordOnly.current = true;
        void record(typed);
      } else if (event.error === "no-speech") setError("Didn’t hear anything. Tap the mic and speak.");
      else if (event.error !== "aborted") setError(`Dictation stopped (${event.error}). Type the message instead.`);
    };
    listener.onaudiostart = () => { opened = true; };
    listener.onend = () => {
      clearTimeout(pause);
      if (refused) return;
      stopDictation.current = null;
      setListening(false);
      // Some recognizers, like Firefox's, can end without ever opening the microphone. The recorder takes over.
      if (!opened) {
        recordOnly.current = true;
        return setError("Didn’t catch that. Tap the mic and say it again.");
      }
      dictated(said.current);
    };
    said.current = typed;
    stopDictation.current = () => listener.stop();
    setListening(true);
    try {
      listener.start();
      stopAfter(8000);
    } catch {
      stopDictation.current = null;
      recordOnly.current = true;
      void record(typed);
    }
  };

  // Record until the doctor stops talking, then the server transcribes it with the OpenAI key.
  const record = async (typed: string) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setListening(false);
      setError("Allow the microphone for this page, then tap the mic again. In Safari: Safari → Settings for This Website → Microphone.");
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(item => MediaRecorder.isTypeSupported(item)) ?? "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    // A pause after speaking ends the message, as does a minute. Speech is measured against the room's own
    // noise, which drops at once and rises slowly, so a busy department doesn't keep the mic open.
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const started = Date.now();
    let heard = false;
    let spoke = false;
    let floor = Infinity;
    let quietSince = started;
    const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
    const watch = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      floor = level < floor ? level : floor + (level - floor) * 0.005;
      const now = Date.now();
      if (level > 0.02) heard = true;
      if (level > Math.max(0.02, floor * 2.5)) {
        spoke = true;
        quietSince = now;
      }
      // Two seconds of quiet leaves time to say "send" after the message.
      if ((spoke && now - quietSince > 2000) || (!spoke && now - started > 8000) || now - started > 60_000) stop();
    }, 100);
    recorder.onstop = async () => {
      clearInterval(watch);
      stream.getTracks().forEach(track => track.stop());
      void context.close();
      stopDictation.current = null;
      setListening(false);
      if (!heard || !chunks.length) return setError("Didn’t hear anything. Tap the mic and speak.");
      setTranscribing(true);
      try {
        const data = new FormData();
        data.append("audio", new Blob(chunks, { type: recorder.mimeType || type }), "dictation");
        const { text } = await api<{ text: string }>("/api/dictation", { method: "POST", body: data });
        dictated([typed, text].filter(Boolean).join(" "));
      } catch (problem) {
        setError((problem as Error).message);
      } finally {
        setTranscribing(false);
      }
    };
    stopDictation.current = stop;
    setListening(true);
    recorder.start();
  };

  // Speak instead of typing.
  const dictate = () => {
    if (stopDictation.current) return stopDictation.current();
    if (transcribing) return;
    if (!window.isSecureContext) return setInsecure(true);
    setError(null);
    setInsecure(false);
    const typed = draft.trim();
    if (recordOnly.current) void record(typed);
    else recognize(typed);
  };
  return <Panel className="ring-emerald-500/25 dark:ring-emerald-400/20">
    <Heading icon={MessagesSquare} aside={messages.length > 0 && <span className="text-xs font-semibold tabular-nums text-slate-500">{messages.length}</span>}>Message the crew</Heading>
    {messages.length
      ? <ol className="space-y-2.5">
        {messages.map(message => {
          const er = message.from === "er";
          const photo: PhotoView | null = message.photo
            ? { id: message.id, file: message.photo, seconds: 0, label: "Photo from the medic", caption: message.text || undefined, when: `sent ${timeOf(message.at)}` }
            : null;
          return <li key={message.id} className={clsx("flex", er ? "justify-end" : "justify-start")}>
            <div className={clsx("max-w-[88%] rounded-2xl px-3.5 py-2.5 ring-1", er
              ? "rounded-br-md bg-emerald-500/10 ring-emerald-500/25 dark:bg-emerald-400/10 dark:ring-emerald-400/25"
              : "rounded-bl-md bg-slate-100 ring-slate-200 dark:bg-white/[0.06] dark:ring-white/10")}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{er ? "ER" : "Medic"} · {timeOf(message.at)}</div>
              {(message.clean || message.text) && <p className="mt-0.5 text-[15px] leading-snug">{message.clean || message.text}</p>}
              {/* The AI tidies a reply for reading; what was actually heard stays one click away. */}
              {message.clean && <details className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-semibold [&::-webkit-details-marker]:hidden"><Sparkles className="size-3" />Tidied by AI · as heard</summary>
                <p className="mt-0.5 italic leading-snug">“{message.heard || message.text}”</p>
              </details>}
              {!er && (message.vitals?.length || message.added && Object.keys(message.added).length) ? <div className="mt-1.5 flex flex-wrap gap-1">
                {message.vitals?.map(vital => <span key={vital.kind} className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700 ring-1 ring-sky-500/20 dark:text-sky-300">
                  {vitalKinds.find(item => item.kind === vital.kind)?.short} {vital.value} logged
                </span>)}
                {Object.keys(message.added ?? {}).map(field => <span key={field} className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-300">
                  <ClipboardCheck className="size-3" />{fieldLabels[field] ?? field} added
                </span>)}
              </div> : null}
              {photo && <button onClick={() => onPhoto(photo)} className="mt-2 block overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-white/10">
                <img src={mediaUrl(session, photo.file)} alt={photo.caption ?? photo.label} className="max-h-52 w-full object-cover" />
              </button>}
              {er && <div className={clsx("mt-1 flex items-center gap-1 text-[11px] font-semibold", message.heard_at ? "text-emerald-700 dark:text-emerald-300" : "text-slate-500 dark:text-slate-400")}>
                {message.heard_at
                  ? <><CheckCheck className="size-3.5" />Read aloud on the glasses · {timeOf(message.heard_at)}</>
                  : <><Hourglass className="size-3.5" />{isLive ? "Read to the medic when the handover ends" : "Waiting for the glasses"}</>}
              </div>}
            </div>
          </li>;
        })}
      </ol>
      : <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">Ask the medic for anything the handover is missing. The glasses read your message aloud, and the medic’s spoken answer appears here, with a photo if you ask for one.</p>}
    <div className="no-print">
      <div className="mt-3 flex flex-wrap gap-1.5">
        {quickAsks(session).map(([label, text]) => <button key={label} disabled={sending} onClick={() => void send(text)} title={text}
          className="h-8 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-200 disabled:opacity-45 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10">{label}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); void send(draft); }} className="mt-3 flex gap-2">
        <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} aria-label="Message to the medic"
          placeholder={listening ? "Listening…" : transcribing ? "Writing down what you said…" : "Ask the medic, or tap the mic…"}
          className="h-10 min-w-0 flex-1 rounded-xl bg-white px-3 text-sm ring-1 ring-slate-300 outline-none transition placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 dark:bg-white/[0.04] dark:ring-white/10" />
        <button type="button" onClick={dictate} disabled={transcribing} aria-pressed={listening} aria-label={listening ? "Stop dictating" : "Speak the message"}
          title={listening ? "Stop dictating" : "Speak the message. End with “send” to send it."}
          className={clsx("grid size-10 shrink-0 place-items-center rounded-xl ring-1 transition", listening
            ? "bg-rose-500 text-white ring-rose-500 motion-safe:animate-beat"
            : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50 dark:bg-white/[0.06] dark:text-slate-200 dark:ring-white/10 dark:hover:bg-white/10")}>
          {listening ? <Square className="size-4" fill="currentColor" /> : transcribing ? <LoaderCircle className="size-[18px] animate-spin" /> : <Mic className="size-[18px]" />}
        </button>
        <Button type="submit" variant="primary" icon={Send} disabled={sending || !draft.trim()}>Send</Button>
      </form>
      {listening && <p className="mt-2 text-xs font-medium text-rose-700 dark:text-rose-300">Listening. End with “send” to send it to the medic, or pause to read it over first.</p>}
      {insecure && <p role="alert" className="mt-2 text-sm leading-snug text-amber-700 dark:text-amber-300">
        Browsers allow the microphone only on a secure address. <a href={secureAddress()} className="font-semibold underline">Open the dashboard at localhost</a> on this Mac, then tap the mic again.
      </p>}
      {error && <p role="alert" className="mt-2 text-sm font-medium text-rose-700 dark:text-rose-300">{error}</p>}
    </div>
  </Panel>;
}
