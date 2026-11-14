import { setupRecorder } from "./recorder.js";

const $ = (id) => document.getElementById(id);
let selectedId = null;
let selected = null;
let importMarks = [];
let previewUrl = null;
let refreshSequence = 0;
let renderRevision = null;
let attachId = null;

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

function refs(ids) {
  return ids
    .map((id) => {
      const item = selected.evidence.find((evidence) => evidence.id === id);
      if (!item) return "";
      return `<button class="source-ref" data-source="${escapeHtml(id)}" title="${item.kind === "image" ? "Frame" : "Transcript interval"}">${item.kind === "image" ? "Frame" : "Audio"} ${time(item.start)}</button>`;
    })
    .join("");
}

function render(session) {
  selected = session;
  renderRevision = session.updated_at;
  $("session-title").textContent = session.report?.title || session.title;
  $("session-meta").textContent =
    `${session.source === "sample" ? "TRAINING SAMPLE" : session.source.toUpperCase()} · ${new Date(session.created_at).toLocaleString()}`;
  $("sample-label").hidden = session.source !== "sample";
  $("duration").textContent = session.duration ? time(session.duration) : "";
  const recording = $("recording");
  const expected = mediaUrl("recording.mp4");
  if (session.duration && recording.getAttribute("src") !== expected)
    recording.src = expected;
  recording.hidden = !session.duration;
  $("processing").hidden = session.status === "complete";
  $("process-title").textContent = labels[session.status] || session.status;
  $("process-detail").textContent = session.error || session.progress;
  $("retry").hidden = !session.has_video || session.status === "processing";
  $("attach-video").hidden = session.has_video;
  $("retry").textContent =
    session.status === "uploaded" ? "Generate report" : "Retry processing";
  $("print").hidden = $("export").hidden = !session.report;
  if (session.report) {
    const report = session.report;
    $("report").innerHTML =
      `<section class="summary"><h2>Handoff summary</h2>${report.summary.map((item) => `<p>${escapeHtml(item.text)} ${refs(item.evidence_ids)}</p>`).join("")}</section>
      ${report.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.statements.map((item) => `<p>${escapeHtml(item.text)} ${refs(item.evidence_ids)}</p>`).join("")}</section>`).join("")}
      <section><h2>Session timeline</h2>${report.timeline.map((item) => `<div class="timeline-row"><div class="timeline-time">${time(item.seconds)}</div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)} ${refs(item.evidence_ids)}</p></div>`).join("")}</section>
      <section><div class="uncertainties"><h2>Unclear or missing information</h2><ul>${report.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></section>`;
  } else
    $("report").innerHTML =
      '<div class="empty-report">The report will appear here after processing. Your recording and marked moments are saved locally.</div>';
  const snaps = session.evidence.filter((item) => item.clip);
  $("snap-count").textContent = String(snaps.length);
  $("snaps").innerHTML = snaps.length
    ? snaps
        .map(
          (item) =>
            `<button class="snap" data-evidence="${escapeHtml(item.id)}"><img src="${mediaUrl(item.file)}" alt="${escapeHtml(item.label)}" loading="lazy"><span>${escapeHtml(item.label)}<small>${time(item.start)} · clip ↗</small></span></button>`,
        )
        .join("")
    : '<p class="muted small">Marked moments appear here after video processing.</p>';
  $("transcript-count").textContent =
    `(${session.transcript.length} intervals)`;
  $("transcript").innerHTML =
    session.transcript
      .map(
        (item) =>
          `<div class="transcript-entry"><button class="source-ref" data-source="${item.id}">${time(item.start)}–${time(item.end)}</button><p>${escapeHtml(item.text)}</p></div>`,
      )
      .join("") ||
    '<p class="muted small">Transcript is available after AI processing.</p>';
}

document.addEventListener("click", (event) => {
  const sessionButton = event.target.closest("[data-session]");
  if (sessionButton) void selectSession(sessionButton.dataset.session);
  const source = event.target.closest("[data-source]");
  if (source) {
    const item = selected.evidence.find(
      (entry) => entry.id === source.dataset.source,
    );
    $("recording").currentTime = item.start;
    $("recording").scrollIntoView({ behavior: "smooth", block: "center" });
    $("recording").play().catch(showError);
  }
  const snap = event.target.closest("[data-evidence]");
  if (snap) {
    const item = selected.evidence.find(
      (entry) => entry.id === snap.dataset.evidence,
    );
    $("evidence-title").textContent = `${item.label} · ${time(item.start)}`;
    $("evidence-image").src = mediaUrl(item.file);
    $("evidence-clip").src = mediaUrl(item.clip);
    $("evidence-dialog").showModal();
  }
});

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
const initialId = location.hash.slice(1);
if (/^[a-f0-9-]{36}$/.test(initialId)) void selectSession(initialId);
else void refresh();

setupRecorder({ api, selectSession, showError });
