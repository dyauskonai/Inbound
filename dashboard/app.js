import { setupRecorder } from "./recorder.js";

const $ = (id) => document.getElementById(id);
let selectedId = null;
let selected = null;
let importMarks = [];
let previewUrl = null;
let refreshSequence = 0;
let renderRevision = null;
let attachId = null;
let seenGlassesVideos = null;
let tab = "report";

const escapeHtml = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const time = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const mediaUrl = (name) => `/media/${selectedId}/${encodeURIComponent(name)}`;
const labels = {
  created: "Awaiting recording",
  recording: "Receiving from glasses",
  waiting_video: "Waiting for glasses video",
  uploaded: "Ready to process",
  processing: "Processing",
  awaiting_key: "API key needed",
  failed: "Needs attention",
  interrupted: "Ready to resume",
  complete: "Report ready",
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Could not complete this request. Check your input and try again.",
    );
  return data;
}

function showError(error) {
  $("notice").textContent = error.message;
  $("notice").hidden = false;
}

async function refresh() {
  const request = ++refreshSequence;
  try {
    const sessions = await api("/api/sessions");
    if (request !== refreshSequence) return;
    const glassesVideos = sessions.filter(
      (session) => session.source === "glasses" && session.status !== "created",
    );
    const incoming = seenGlassesVideos && glassesVideos.find(
      (session) => !seenGlassesVideos.has(session.id),
    );
    seenGlassesVideos = new Set(glassesVideos.map((session) => session.id));
    if (incoming && incoming.id !== selectedId && (!selectedId || selected?.status === "created") && !$("import-dialog").open) {
      await selectSession(incoming.id);
      return;
    }
    $("sessions").innerHTML = sessions
      .map(
        (session) =>
          `<button class="session-link ${session.id === selectedId ? "active" : ""}" data-session="${session.id}">${escapeHtml(session.title)}<small>${labels[session.status] || escapeHtml(session.status)}${session.source === "sample" ? " · Sample" : ""}</small></button>`,
      )
      .join("");
    if (selectedId) {
      const session = await api(`/api/sessions/${selectedId}`);
      if (
        request === refreshSequence &&
        session.id === selectedId &&
        session.updated_at !== renderRevision
      )
        render(session);
    }
  } catch (error) {
    showError(error);
  }
}

async function selectSession(id) {
  selectedId = id;
  renderRevision = null;
  history.replaceState(null, "", `/#${id}`);
  $("welcome").hidden = true;
  $("session-view").hidden = false;
  $("notice").hidden = true;
  await refresh();
}

const isPhoto = (item) => item.kind === "image" && item.id.startsWith("snap_");
// Uploaded and Mac recordings are video themselves; glasses captures carry the glasses' video separately.
const videoOf = (session) =>
  session.has_video
    ? { state: "ready", file: "recording.mp4", offset: 0, duration: session.duration }
    : session.video || null;
const videoMessages = {
  recording: "The glasses are recording video. It uploads over their Wi-Fi after Stop.",
  stopping: "The glasses are stopping the video.",
  uploading: "Waiting for the glasses to upload the video over Wi-Fi. Keep them connected to a network that reaches this server.",
  failed: "The glasses could not record or upload video. The report uses the phone's audio and photos.",
};

function showTab(name) {
  tab = name;
  for (const button of document.querySelectorAll("[data-tab]"))
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  $("report-layout").hidden = name !== "report";
  $("video-view").hidden = name !== "video";
  if (name !== "video") $("full-video").pause();
}

function renderVideo(session, snaps) {
  const video = videoOf(session);
  const ready = video?.state === "ready";
  const full = $("full-video");
  if (ready && full.getAttribute("src") !== mediaUrl(video.file)) full.src = mediaUrl(video.file);
  if (!ready) full.removeAttribute("src");
  full.hidden = !ready;
  $("attach-glasses-video").hidden = ready || session.source !== "glasses" || !session.capture_finished;
  $("video-badge").textContent = ready
    ? `· ${time(video.duration || 0)}`
    : video?.state === "failed" ? "· unavailable" : video?.state === "recording" ? "· recording" : video ? "· uploading" : "";
  $("video-status").textContent = ready
    ? video.offset ? `The glasses started recording ${time(video.offset)} after Start. Photo times below are matched to the video.` : ""
    : video
      ? [videoMessages[video.state], video.state === "failed" ? video.detail : ""].filter(Boolean).join(" ")
      : "No video was recorded for this capture. Turn on “Also record video on the glasses” in Inbound before starting.";
  const offset = ready ? video.offset || 0 : 0;
  $("video-moments").innerHTML = ready && snaps.length
    ? snaps.map((item) => {
        const at = Math.max(0, item.start - offset);
        return `<button class="moment-link" data-seek="${at}">${escapeHtml(item.label)}<small>${time(at)}</small></button>`;
      }).join("")
    : `<p class="muted small">${ready ? "No photos were taken in this capture." : "Photo moments appear here once the video is ready."}</p>`;
  showTab(tab);
}
// The glasses' own video, once it has arrived for a capture that went through the phone.
const glassesVideo = (session) => (!session?.has_video && session?.video?.state === "ready" ? session.video : null);
const player = () => (selected?.has_video || glassesVideo(selected) ? $("recording") : $("recording-audio"));
// Evidence times count from Start; the glasses' video starts a moment later.
const playerTime = (seconds) => Math.max(0, seconds - (glassesVideo(selected)?.offset || 0));

function refs(ids) {
  return ids
    .map((id) => {
      const item = selected.evidence.find((evidence) => evidence.id === id);
      if (!item) return "";
      const label = isPhoto(item) ? "Photo" : item.kind === "image" ? "Frame" : item.kind === "vital" ? "Vital" : item.source === "phone" ? "Said" : "Audio";
      return `<button class="source-ref" data-source="${escapeHtml(id)}" title="${item.kind === "image" ? "Image" : "Transcript interval"}">${label} ${time(item.start)}</button>`;
    })
    .join("");
}

// Values are the medic's spoken report. They are unconfirmed until a person checks them.
function handoffCard(card) {
  const value = (text) =>
    text === null || text === undefined || text === ""
      ? '<span class="not-reported">Not reported</span>'
      : escapeHtml(text);
  // Vitals the medic repeated when the glasses asked are confirmed, and ones the medic changed
  // later are updated. The rest are as reported.
  const marks = new Map([
    ...(card.confirmed_fields || []).map((field) => [field, ["confirmed", "✓ confirmed", "The medic repeated this value when the glasses asked"]]),
    ...(card.updated_fields || []).map((field) => [field, ["confirmed", "✓ updated", "The medic changed this value, and the glasses read it back"]]),
    ...(card.unconfirmed_fields || []).map((field) => [field, ["unconfirmed", "", ""]]),
  ]);
  const rows = [
    ["BP", "blood_pressure", card.blood_pressure],
    ["Heart rate", "heart_rate", card.heart_rate],
    ["SpO₂", "spo2", card.spo2],
    ["Resp. rate", "respiratory_rate", card.respiratory_rate],
    ["Age", "patient_age", card.patient_age],
    ["Sex", "patient_sex", card.patient_sex],
    ["Allergies", "allergies", card.allergies],
    ["ETA", "eta_minutes", card.eta_minutes === null ? null : `${card.eta_minutes} min`],
  ];
  return `<section class="handoff"><h2>Handoff card · medic's report</h2>
    <dl>${rows.map(([label, field, text]) => {
      const [style, badge, title] = marks.get(field) || ["", "", ""];
      return `<div class="${style}"><dt>${label}${badge ? ` <span title="${title}">${badge}</span>` : ""}</dt><dd>${value(text)}</dd></div>`;
    }).join("")}</dl>
    <p><b>Injuries</b> ${card.injuries.length ? card.injuries.map(escapeHtml).join("; ") : value(null)}</p>
    <p><b>Mechanism</b> ${value(card.mechanism)}</p>
    ${card.missing_fields.length ? `<p class="missing-fields">Missing: ${card.missing_fields.map((field) => escapeHtml(field.replaceAll("_", " "))).join(", ")}</p>` : ""}
    <p>${refs(card.evidence_ids)}</p></section>`;
}

const vitalLabels = { bp: "BP", hr: "Heart rate", spo2: "SpO₂", rr: "Resp. rate" };
const vitalStatus = { heard: "Heard", conflict: "Asked to repeat", confirmed: "✓ Confirmed", updated: "✓ Updated", unconfirmed: "Not confirmed" };

// Before the report is written, the ER sees each vital as the phone logs it.
function liveVitals(vitals) {
  const latest = new Map(vitals.map((vital) => [vital.kind, vital]));
  return `<section class="handoff"><h2>Vitals heard so far</h2><dl>${[...latest.values()]
    .map((vital) => {
      // Until the medic repeats it, both values stay on screen.
      const shown = ["conflict", "unconfirmed"].includes(vital.status) && vital.candidates.length ? vital.candidates.join(" or ") : vital.value;
      return `<div class="${["confirmed", "updated"].includes(vital.status) ? "confirmed" : vital.status === "heard" ? "" : "unconfirmed"}"><dt>${vitalLabels[vital.kind]} · ${vitalStatus[vital.status]}</dt><dd>${escapeHtml(shown)}${vital.kind === "spo2" ? "%" : ""}</dd></div>`;
    })
    .join("")}</dl></section>`;
}

function render(session) {
  selected = session;
  renderRevision = session.updated_at;
  $("session-title").textContent = session.report?.title || session.title;
  $("session-meta").textContent =
    `${session.source === "sample" ? "TRAINING SAMPLE" : session.source.toUpperCase()} · ${new Date(session.created_at).toLocaleString()}`;
  $("sample-label").hidden = session.source !== "sample";
  $("duration").textContent = session.duration ? time(session.duration) : "";
  const audioOnly = session.media === "audio";
  const fromGlasses = glassesVideo(session);
  for (const [id, name, show] of [
    ["recording", fromGlasses ? fromGlasses.file : "recording.mp4", (session.has_video && session.duration) || fromGlasses],
    // The phone's audio, unless the glasses' video already carries sound.
    ["recording-audio", "recording.wav", audioOnly && !fromGlasses?.has_audio],
  ]) {
    const element = $(id);
    if (show && element.getAttribute("src") !== mediaUrl(name))
      element.src = mediaUrl(name);
    element.hidden = !show;
  }
  const photos = session.photos || [];
  const notes = session.notes || [];
  const received = session.has_video || photos.length || notes.length || Object.keys(session.audio_parts || {}).length;
  $("processing").hidden = session.status === "complete";
  $("process-title").textContent = labels[session.status] || session.status;
  $("process-detail").textContent = session.error || session.progress;
  $("retry").hidden = !received || session.status === "processing";
  $("attach-video").hidden = session.has_video || session.source === "glasses";
  $("retry").textContent =
    session.status === "uploaded" ? "Generate report" : "Retry processing";
  $("print").hidden = $("export").hidden = !session.report;
  if (session.report) {
    const report = session.report;
    $("report").innerHTML =
      `${report.handoff ? handoffCard(report.handoff) : ""}<section class="summary"><h2>Handoff summary</h2>${report.summary.map((item) => `<p>${escapeHtml(item.text)} ${refs(item.evidence_ids)}</p>`).join("")}</section>
      ${report.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.statements.map((item) => `<p>${escapeHtml(item.text)} ${refs(item.evidence_ids)}</p>`).join("")}</section>`).join("")}
      <section><h2>Session timeline</h2>${report.timeline.map((item) => `<div class="timeline-row"><div class="timeline-time">${time(item.seconds)}</div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)} ${refs(item.evidence_ids)}</p></div>`).join("")}</section>
      <section><div class="uncertainties"><h2>Unclear or missing information</h2><ul>${report.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></section>`;
  } else
    $("report").innerHTML =
      (session.vitals?.length ? liveVitals(session.vitals) : "") +
      '<div class="empty-report">The report will appear here after processing. Your recording and marked moments are saved locally.</div>';
  // Photos show up as they arrive, before the report is processed.
  const snaps = session.evidence.some(isPhoto)
    ? session.evidence.filter(isPhoto)
    : photos.map((photo) => ({ id: photo.id, kind: "image", file: photo.file, start: photo.seconds, label: `Photo ${photo.seq}` }));
  const captions = new Map((session.report?.snap_captions || []).map((item) => [item.evidence_id, item.caption]));
  $("snap-count").textContent = String(snaps.length);
  $("snaps").innerHTML = snaps.length
    ? snaps
        .map(
          (item) =>
            `<button class="snap" data-evidence="${escapeHtml(item.id)}"><img src="${mediaUrl(item.file)}" alt="${escapeHtml(item.label)}" loading="lazy"><span>${escapeHtml(item.label)}<small>${time(item.start)}${item.clip ? " · clip ↗" : ""}</small></span>${captions.has(item.id) ? `<p class="snap-caption">${escapeHtml(captions.get(item.id))}</p>` : ""}</button>`,
        )
        .join("")
    : '<p class="muted small">Photos and marked moments appear here as they arrive.</p>';
  const lines = session.transcript.length
    ? session.transcript
    : notes.map((note) => ({ id: `note_${note.seq}`, start: note.seconds, end: note.seconds, text: note.text }));
  renderVideo(session, snaps);
  $("transcript-count").textContent = `(${lines.length} ${lines.length === 1 ? "entry" : "entries"})`;
  $("transcript-section").open ||= session.status === "recording" && lines.length > 0;
  $("transcript").innerHTML =
    lines
      .map(
        (item) =>
          `<div class="transcript-entry"><button class="source-ref" data-source="${escapeHtml(item.id)}">${time(item.start)}${item.end > item.start ? `–${time(item.end)}` : ""}</button><p>${escapeHtml(item.text)}</p></div>`,
      )
      .join("") ||
    '<p class="muted small">Transcript is available after AI processing.</p>';
}

document.addEventListener("click", (event) => {
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) showTab(tabButton.dataset.tab);
  const seek = event.target.closest("[data-seek]");
  if (seek) {
    $("full-video").currentTime = Number(seek.dataset.seek);
    $("full-video").play().catch(showError);
  }
  const sessionButton = event.target.closest("[data-session]");
  if (sessionButton) void selectSession(sessionButton.dataset.session);
  const source = event.target.closest("[data-source]");
  const sourceItem = source && selected.evidence.find((entry) => entry.id === source.dataset.source);
  if (sourceItem && isPhoto(sourceItem)) showEvidence(sourceItem);
  else if (sourceItem && !player().hidden) {
    player().currentTime = playerTime(sourceItem.start);
    player().scrollIntoView({ behavior: "smooth", block: "center" });
    player().play().catch(showError);
  }
  const snap = event.target.closest("[data-evidence]");
  if (snap) {
    const photo = (selected.photos || []).find((entry) => entry.id === snap.dataset.evidence);
    showEvidence(
      selected.evidence.find((entry) => entry.id === snap.dataset.evidence) ||
        { id: photo.id, file: photo.file, start: photo.seconds, label: `Photo ${photo.seq}` },
    );
  }
});

function showEvidence(item) {
  $("evidence-title").textContent = `${item.label} · ${time(item.start)}`;
  const caption = selected.report?.snap_captions?.find((entry) => entry.evidence_id === item.id)?.caption;
  $("evidence-caption").textContent = caption || "";
  $("evidence-caption").hidden = !caption;
  $("evidence-image").src = mediaUrl(item.file);
  $("evidence-clip").hidden = !item.clip;
  if (item.clip) $("evidence-clip").src = mediaUrl(item.clip);
  else $("evidence-clip").removeAttribute("src");
  $("evidence-dialog").showModal();
}

function openImport() {
  attachId = null;
  $("import-dialog").showModal();
}
$("attach-video").onclick = () => {
  attachId = selectedId;
  importMarks = [...selected.bookmarks];
  $("import-title").value = selected.title;
  renderImportMarks();
  $("import-dialog").showModal();
};
["new-session", "welcome-import"].forEach((id) =>
  $(id).addEventListener("click", openImport),
);
$("close-import").onclick = () => {
  $("import-preview").pause();
  $("import-dialog").close();
};
$("close-evidence").onclick = () => {
  $("evidence-clip").pause();
  $("evidence-dialog").close();
};
$("evidence-dialog").addEventListener("close", () =>
  $("evidence-clip").pause(),
);
$("import-dialog").addEventListener("close", () => $("import-preview").pause());

async function openSample() {
  $("sample").disabled = $("welcome-sample").disabled = true;
  try {
    const session = await api("/api/sample", { method: "POST" });
    await selectSession(session.id);
  } catch (error) {
    showError(error);
  } finally {
    $("sample").disabled = $("welcome-sample").disabled = false;
  }
}
$("sample").onclick = $("welcome-sample").onclick = openSample;

$("video-file").onchange = () => {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  const file = $("video-file").files[0];
  if (!attachId) importMarks = [];
  renderImportMarks();
  $("add-snap").disabled = true;
  if (!file) return;
  if (!$("import-title").value)
    $("import-title").value = file.name.replace(/\.[^.]+$/, "").slice(0, 120);
  previewUrl = URL.createObjectURL(file);
  $("import-preview").src = previewUrl;
  $("import-preview").hidden = false;
};
$("import-preview").onloadedmetadata = () => {
  $("add-snap").disabled = false;
};
$("add-snap").onclick = () => {
  if (importMarks.length >= 40) return;
  importMarks.push({
    id: crypto.randomUUID(),
    seconds: $("import-preview").currentTime,
    label: $("snap-label").value || "Snap",
  });
  $("snap-label").value = "";
  renderImportMarks();
};
function renderImportMarks() {
  $("import-snaps").innerHTML = importMarks
    .map(
      (item) =>
        `<div class="import-mark">${time(item.seconds)} · ${escapeHtml(item.label)}<button type="button" class="quiet" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.label)}">✕</button></div>`,
    )
    .join("");
}
$("import-snaps").onclick = (event) => {
  const button = event.target.closest("[data-remove]");
  if (button) {
    importMarks = importMarks.filter(
      (item) => item.id !== button.dataset.remove,
    );
    renderImportMarks();
  }
};
$("import-form").onsubmit = async (event) => {
  event.preventDefault();
  const file = $("video-file").files[0];
  if (!file) return;
  $("import-submit").disabled = true;
  $("import-submit").textContent = "Uploading recording…";
  $("import-error").hidden = true;
  try {
    const session = attachId
      ? { id: attachId }
      : await api("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: $("import-title").value,
            source: "upload",
          }),
        });
    attachId = session.id;
    await api(`/api/sessions/${session.id}/capture`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookmarks: importMarks }),
    });
    const data = new FormData();
    data.append("video", file);
    await api(`/api/sessions/${session.id}/video`, {
      method: "POST",
      body: data,
    });
    await api(`/api/sessions/${session.id}/process`, { method: "POST" });
    $("import-preview").pause();
    $("import-dialog").close();
    $("import-form").reset();
    $("import-preview").hidden = true;
    importMarks = [];
    renderImportMarks();
    await selectSession(session.id);
  } catch (error) {
    $("import-error").textContent = error.message;
    $("import-error").hidden = false;
  } finally {
    $("import-submit").disabled = false;
    $("import-submit").textContent = "Upload and prepare report";
  }
};
$("retry").onclick = async () => {
  $("retry").disabled = true;
  try {
    await api(`/api/sessions/${selectedId}/process`, { method: "POST" });
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    $("retry").disabled = false;
  }
};
$("glasses-video-file").onchange = async () => {
  const file = $("glasses-video-file").files[0];
  if (!file) return;
  const data = new FormData();
  data.append("video", file);
  $("attach-glasses-status").textContent = "Uploading the video…";
  try {
    await api(`/api/sessions/${selectedId}/video`, { method: "POST", body: data });
    $("attach-glasses-status").textContent = "Video attached.";
    await refresh();
  } catch (error) {
    $("attach-glasses-status").textContent = error.message;
  } finally {
    $("glasses-video-file").value = "";
  }
};
$("print").onclick = () => window.print();
$("export").onclick = async () => {
  try {
    const result = await api(`/api/sessions/${selectedId}/report.json`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `inbound-${selectedId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showError(error);
  }
};

api("/api/health")
  .then((health) => {
    $("ai-status").textContent = health.ai_configured
      ? "AI configured"
      : "OpenAI key needed";
    $("ai-status").classList.toggle("warning", !health.ai_configured);
  })
  .catch(showError);
const events = new EventSource("/events");
events.onopen = () => {
  $("connection").textContent = "Connected to local server";
};
events.onerror = () => {
  $("connection").textContent = "Reconnecting to server";
};
events.addEventListener("update", () => void refresh());
// Some HTTPS proxies, like Cloudflare quick tunnels, hold back event streams. Poll as well.
setInterval(() => void refresh(), 3000);
const initialId = location.hash.slice(1);
if (/^[a-f0-9-]{36}$/.test(initialId)) void selectSession(initialId);
else void refresh();

setupRecorder({ api, selectSession, showError });
