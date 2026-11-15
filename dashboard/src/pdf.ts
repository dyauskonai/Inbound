import { jsPDF } from "jspdf";
import { arrival, clock, identity, mediaUrl, type Handoff, type Session } from "./data";
import { crewQuestions, fieldLabels, photosOf, severityStyle, sourceLabels, statusBadge, vitalAlerts } from "./Patient";
import { severity, vitalKinds, vitalViews, type VitalView } from "./vitals";

// The handover as a PDF to print, file with the chart, or pass on: what the dashboard shows, laid out
// for paper. It's built here in the browser, so it doesn't depend on the browser's print dialog.

// US Letter, in points.
const PAGE = { width: 612, height: 792 };
const LEFT = 44;
const WIDTH = PAGE.width - LEFT * 2;
const TOP = 40;
// Where text starts below the running header on later pages, and where it must stop above the footer.
const CONTINUED = TOP + 34;
const BOTTOM = PAGE.height - 54;

const ink = { text: "#0f172a", body: "#334155", muted: "#64748b", faint: "#94a3b8", rule: "#e2e8f0", strong: "#cbd5e1", wash: "#f1f5f9", brand: "#10b981" };
// Light on paper; the words always say what the colour does.
const tints = {
  critical: { text: "#be123c", fill: "#fff1f2", line: "#fecdd3" },
  warn: { text: "#b45309", fill: "#fffbeb", line: "#fde68a" },
  ok: { text: "#047857", fill: "#ecfdf5", line: "#a7f3d0" },
  info: { text: "#0369a1", fill: "#f0f9ff", line: "#bae6fd" },
  idle: { text: "#475569", fill: "#ffffff", line: "#e2e8f0" },
};
type Tint = keyof typeof tints;
type Style = "normal" | "bold" | "italic";

// The PDF's built-in Helvetica covers Windows-1252: no arrows, subscripts or emoji.
const WIN_ANSI = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const SWAPS: Record<string, string> = { "₂": "2", "→": "›", "≈": "~", "≥": ">=", "≤": "<=", "μ": "µ" };
const plain = (text: string) => text
  // Any space becomes a plain one: browsers put a narrow no-break space before "PM".
  .replace(/\s+/g, " ")
  .replace(/[^\x20-\x7e\xa0-\xff]/g, char => SWAPS[char] ?? (WIN_ANSI.includes(char) ? char : ""));

const time = (when: string | number | Date) => new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (when: string | number | Date) => new Date(when).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });

interface Shot { label: string; when: string; caption?: string; image: { data: string; width: number; height: number } }

// A photo as a JPEG small enough for the page. 1400 pixels is still sharp in print.
async function jpeg(url: string) {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { data: canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height };
}

/** The handover PDF for a patient, with its photos and the photos the medic sent in replies. */
export async function handoverPdf(session: Session) {
  const shots = [
    ...photosOf(session).map(photo => ({ label: photo.label, when: photo.when ?? `${clock(photo.seconds)} after start`, caption: photo.caption, file: photo.file })),
    ...(session.messages ?? []).filter(message => message.photo).map(message => ({
      label: "Photo from the medic", when: `sent ${time(message.at)}`, caption: message.clean || message.text || undefined, file: message.photo!,
    })),
  ];
  const loaded = await Promise.all(shots.map(async ({ file, ...shot }) => {
    const image = await jpeg(mediaUrl(session, file));
    return image ? { ...shot, image } : null;
  }));
  return writeHandover(session, loaded.filter(shot => shot !== null), new Date());
}

interface Part { text: string; color?: string; style?: Style; bullet?: boolean }
// Something drawn whole, measured first so it never splits across pages.
interface Block { height: number; draw: (top: number) => void }
interface Row { letter: string; label: string; parts: Part[]; from?: string }

// IMIST-AMBO, as on the dashboard: what's missing in amber, what the medic added later marked with when.
function imistRows(handoff: Handoff, vitals: VitalView[]): Row[] {
  const missing = new Set(handoff.missing_fields);
  const empty = (field: string, text = "Not reported"): Part => missing.has(field)
    ? { text: `${text} · ask the crew`, color: tints.warn.text, style: "bold" }
    : { text, color: ink.faint };
  const list = (items: string[] | undefined, none: Part): Part[] => items?.length ? items.map(text => ({ text, bullet: true })) : [none];
  const signs = vitals.filter(vital => vital.value || vital.candidates.length).map(vital => {
    const { short } = vitalKinds.find(item => item.kind === vital.kind)!;
    return vital.value ? `${short} ${vital.value}${vital.kind === "spo2" ? "%" : ""}` : `${short} ${vital.candidates.join(" or ")} (not confirmed)`;
  });
  const sources = handoff.reply_sources ?? {};
  const fromCrew = (...fields: string[]) => fields.map(field => sources[field]?.at).filter(Boolean).sort().at(-1);
  const who = [handoff.patient_age && `${handoff.patient_age} years`, handoff.patient_sex].filter(Boolean).join(" · ");
  const eta = handoff.eta_minutes;
  return [
    { letter: "I", label: "Identification", from: fromCrew("patient_age", "patient_sex"), parts: [who ? { text: who } : empty("patient_age")] },
    { letter: "M", label: "Mechanism", from: fromCrew("mechanism"), parts: [handoff.mechanism ? { text: handoff.mechanism } : empty("mechanism")] },
    { letter: "I", label: "Injuries", from: fromCrew("injuries"), parts: list(handoff.injuries, empty("injuries")) },
    {
      letter: "S", label: "Signs", from: fromCrew("consciousness"), parts: [
        handoff.consciousness ? { text: handoff.consciousness } : empty("consciousness", "Consciousness not reported"),
        ...(signs.length ? [{ text: signs.join(" · "), color: ink.muted }] : []),
      ],
    },
    { letter: "T", label: "Treatment", from: fromCrew("treatment"), parts: list(handoff.treatment, { text: "None reported", color: ink.faint }) },
    { letter: "A", label: "Allergies", from: fromCrew("allergies"), parts: [handoff.allergies ? { text: handoff.allergies } : empty("allergies")] },
    { letter: "M", label: "Medications", from: fromCrew("medications"), parts: [handoff.medications ? { text: handoff.medications } : empty("medications")] },
    { letter: "B", label: "Background", from: fromCrew("history"), parts: [handoff.history ? { text: handoff.history } : { text: "Not reported", color: ink.faint }] },
    {
      letter: "O", label: "Other", from: fromCrew("eta_minutes"), parts: [eta == null ? empty("eta_minutes")
        : { text: sources.eta_minutes ? `ETA ${eta} min, given at ${time(sources.eta_minutes.at)}` : `ETA ${eta} min when reported` }],
    },
  ];
}

/** Lays out the PDF. `made` is the time printed on it. */
function writeHandover(session: Session, shots: Shot[], made: Date) {
  const report = session.report!;
  const handoff = report.handoff ?? null;
  const vitals = vitalViews(session.vitals, handoff);
  const { who, what } = identity({ handoff, headline: report.title, title: session.title });
  const patient = `${who} · ${what}`;
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
  doc.setProperties({ title: plain(`Inbound handover · ${patient}`), subject: "Pre-arrival handover", creator: "Inbound", author: "Inbound" });
  let y = TOP;

  const font = (size: number, style: Style = "normal", color = ink.text) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(color);
  };
  // Lines that fit `width` in the current font.
  const wrap = (text: string, width: number): string[] => doc.splitTextToSize(plain(text), width);
  // Lines placed by the top of their line box, `leading` points apart, rather than by their baseline.
  const write = (lines: string[], x: number, top: number, leading: number) => {
    const size = doc.getFontSize();
    lines.forEach((line, index) => doc.text(line, x, top + index * leading + (leading - size) / 2 + size * 0.78));
  };
  // Letter-spaced capitals for labels. jsPDF doesn't count the spacing when it aligns text, so this does.
  const caps = (text: string, x: number, top: number, align: "left" | "right" = "left") => {
    const label = plain(text);
    const width = doc.getTextWidth(label) + 0.9 * (label.length - 1);
    doc.text(label, align === "right" ? x - width : x, top + doc.getFontSize() * 0.78, { charSpace: 0.9 });
  };
  // The first line of `text` that fits, shortened if it doesn't.
  const fit = (text: string, width: number) => {
    const lines = wrap(text, width);
    return lines.length > 1 ? `${lines[0].replace(/[\s,.;:·-]+$/, "")}…` : lines[0] ?? "";
  };
  // A new page when `height` more points won't fit on this one.
  const room = (height: number) => {
    if (y + height <= BOTTOM) return;
    doc.addPage();
    y = CONTINUED;
  };
  const rule = (at: number, color = ink.rule) => {
    doc.setDrawColor(color);
    doc.setLineWidth(0.6);
    doc.line(LEFT, at, LEFT + WIDTH, at);
  };
  const box = (x: number, top: number, width: number, height: number, tint: Tint, radius = 6) => {
    doc.setFillColor(tints[tint].fill);
    doc.setDrawColor(tints[tint].line);
    doc.setLineWidth(0.8);
    doc.roundedRect(x, top, width, height, radius, radius, "FD");
  };
  // A section title that never ends a page: `keep` is how much of what follows must fit under it.
  const section = (title: string, note: string | undefined, keep: number) => {
    room(38 + keep);
    y += 18;
    font(7.5, "bold", ink.muted);
    caps(title.toUpperCase(), LEFT, y);
    if (note) {
      font(7.5, "normal", ink.faint);
      doc.text(plain(note), LEFT + WIDTH, y + 7.5 * 0.78, { align: "right" });
    }
    y += 11;
    rule(y);
    y += 9;
  };
  // A titled run of blocks, each kept whole. The title moves to the next page with its first block.
  const blocks = (title: string, note: string | undefined, items: Block[]) => {
    if (!items.length) return;
    section(title, note, items[0].height);
    for (const item of items) {
      room(item.height);
      item.draw(y);
      y += item.height;
    }
  };
  // The dashboard's wordmark: "inbound" and a green arrow coming in.
  const wordmark = (x: number, baseline: number, size: number) => {
    font(size, "bold", ink.text);
    doc.text("inbound", x, baseline);
    const left = x + doc.getTextWidth("inbound") + size * 0.1;
    const span = size * 0.4;
    const top = baseline - size * 0.6;
    doc.setDrawColor(ink.brand);
    doc.setLineWidth(size * 0.09);
    doc.setLineCap("round");
    doc.setLineJoin("round");
    doc.line(left, top, left + span, top + span);
    doc.line(left + span, top + span, left + span * 0.38, top + span);
    doc.line(left + span, top + span, left + span, top + span * 0.38);
    doc.setLineCap("butt");
    doc.setLineJoin("miter");
  };

  // Masthead.
  wordmark(LEFT, TOP + 16, 20);
  font(7.5, "bold", tints.ok.text);
  caps("PRE-ARRIVAL HANDOVER", LEFT + WIDTH, TOP + 2, "right");
  font(8, "normal", ink.muted);
  doc.text(plain(`Generated ${day(made)}, ${time(made)}`), LEFT + WIDTH, TOP + 20, { align: "right" });
  y = TOP + 30;
  rule(y, ink.strong);
  y += 14;

  // Who is coming and when, the way the board says it.
  const eta = arrival({ handoff, created_at: session.created_at, capture_seconds: session.capture_seconds ?? null, duration: session.duration });
  const side = eta ? 160 : 0;
  const top = y;
  font(8.5, "normal", ink.muted);
  doc.text(plain(`${sourceLabels[session.source]} · received ${day(session.created_at)} at ${time(session.created_at)}`), LEFT, y + 7);
  y += 16;
  if (session.source === "sample") {
    const text = "TRAINING SAMPLE · FICTIONAL PATIENT";
    font(7, "bold", tints.warn.text);
    box(LEFT, y, doc.getTextWidth(text) + 0.9 * (text.length - 1) + 14, 14, "warn", 7);
    caps(text, LEFT + 7, y + 4);
    y += 20;
  }
  font(21, "bold", ink.text);
  const heading = wrap(patient, WIDTH - side - 12);
  write(heading, LEFT, y, 25);
  y += heading.length * 25;
  if (report.title && report.title !== what) {
    font(11, "normal", ink.muted);
    const subtitle = wrap(report.title, WIDTH - side - 12);
    write(subtitle, LEFT, y + 2, 15);
    y += subtitle.length * 15 + 2;
  }
  if (eta) {
    // An ETA the medic gave in a reply counts from then; otherwise from the end of the handover.
    const given = handoff?.reply_sources?.eta_minutes?.at
      ?? Date.parse(session.created_at) + (session.capture_seconds ?? session.duration ?? 0) * 1000;
    const right = LEFT + WIDTH;
    font(7.5, "bold", ink.muted);
    caps("EXPECTED ARRIVAL", right, top, "right");
    font(22, "bold", ink.text);
    doc.text(plain(time(eta)), right, top + 31, { align: "right" });
    font(8, "normal", ink.muted);
    doc.text(plain(`ETA ${handoff!.eta_minutes} min, given ${time(given)}`), right, top + 45, { align: "right" });
    y = Math.max(y, top + 50);
  }
  y += 10;

  // Only what is actually off, as on the dashboard.
  for (const alert of vitalAlerts(vitals)) {
    const tint = tints[alert.tone];
    font(9.5, "bold", tint.text);
    const lines = wrap(alert.text, WIDTH - 40);
    const height = lines.length * 13 + 14;
    room(height + 6);
    box(LEFT, y, WIDTH, height, alert.tone);
    doc.setFillColor(tint.text);
    doc.circle(LEFT + 15, y + height / 2, 5.5, "F");
    font(8, "bold", "#ffffff");
    doc.text("!", LEFT + 15, y + height / 2 + 2.9, { align: "center" });
    font(9.5, "bold", tint.text);
    write(lines, LEFT + 28, y + 7, 13);
    y += height + 6;
  }

  // Vitals, coloured by NEWS2 band, with how each was confirmed.
  const tileHeight = 88;
  section("Vital signs", "Colours: NEWS2 bands (adult) · Read back: the glasses repeated it and the medic confirmed", tileHeight);
  const gap = 8;
  const tileWidth = (WIDTH - gap * 3) / 4;
  vitals.forEach((vital, index) => {
    const x = LEFT + index * (tileWidth + gap);
    const kind = vitalKinds.find(item => item.kind === vital.kind)!;
    const unsettled = vital.candidates.length > 0;
    const level = severity(vital.points);
    const tone: Tint = unsettled ? "warn" : vital.value ? severityStyle[level].tone as Tint : "idle";
    box(x, y, tileWidth, tileHeight, tone);
    font(8.5, "bold", ink.muted);
    doc.text(plain(kind.label), x + 10, y + 17);
    if (unsettled) {
      font(12, "bold", tints.warn.text);
      write(wrap(vital.candidates.join(" or "), tileWidth - 20).slice(0, 2), x + 10, y + 26, 14);
    } else {
      // As big as fits: "190/110 mmHg" has to sit inside the tile.
      const value = vital.value ?? "—";
      const space = kind.unit === "%" ? 1 : 3;
      font(8.5);
      const unitWidth = vital.value ? doc.getTextWidth(kind.unit) + space : 0;
      let size = 22;
      font(size, "bold");
      while (size > 14 && doc.getTextWidth(value) + unitWidth > tileWidth - 20) font(--size, "bold");
      font(size, "bold", vital.value ? tints[tone].text : ink.faint);
      doc.text(plain(value), x + 10, y + 46);
      if (vital.value) {
        const width = doc.getTextWidth(value);
        font(8.5, "normal", ink.muted);
        doc.text(kind.unit, x + 10 + width + space, y + 46);
      }
    }
    font(7.5, "bold", vital.value || unsettled ? tints[tone].text : ink.muted);
    doc.text(plain(vital.value ? severityStyle[level].label : unsettled ? "Waiting for the medic" : "Not reported"), x + 10, y + 61);
    if (vital.value || unsettled) {
      font(7.5, "normal", ink.muted);
      doc.text(plain(statusBadge[vital.status].label), x + 10, y + 72);
    }
    if (vital.history.length > 1) {
      font(7.5, "normal", ink.muted);
      doc.text(fit(`Trend ${vital.history.map(reading => reading.value).join(" → ")}`, tileWidth - 20), x + 10, y + 82);
    }
  });
  y += tileHeight + 2;

  if (handoff) {
    const labelWidth = 128;
    const contentX = LEFT + labelWidth;
    const contentWidth = WIDTH - labelWidth;
    blocks("Handover", "IMIST-AMBO", imistRows(handoff, vitals).map(row => {
      const parts = row.parts.map(part => {
        font(10, part.style);
        return { ...part, lines: wrap(part.text, contentWidth - (part.bullet ? 10 : 0)) };
      });
      const height = parts.reduce((sum, part) => sum + part.lines.length * 13.5, 0) + (row.from ? 14 : 0) + 12;
      return {
        height, draw: top => {
          doc.setFillColor("#d1fae5");
          doc.roundedRect(LEFT, top + 6, 16, 16, 4, 4, "F");
          font(9, "bold", tints.ok.text);
          doc.text(row.letter, LEFT + 8, top + 17.2, { align: "center" });
          font(9, "bold", ink.muted);
          doc.text(row.label, LEFT + 24, top + 17.2);
          let line = top + 7.6;
          for (const part of parts) {
            font(10, part.style, part.color ?? ink.text);
            if (part.bullet) {
              doc.setFillColor(ink.faint);
              doc.circle(contentX + 3, line + 6.2, 1.5, "F");
            }
            write(part.lines, contentX + (part.bullet ? 10 : 0), line, 13.5);
            line += part.lines.length * 13.5;
          }
          if (row.from) {
            font(7.5, "bold", tints.info.text);
            doc.text(plain(`From the crew · ${time(row.from)}`), contentX, line + 9);
          }
          rule(top + height);
        },
      };
    }));

    // On paper, a checklist to tick at the door.
    const asks = crewQuestions(handoff, vitals);
    blocks("Ask the crew on arrival", String(asks.length), asks.map(ask => {
      font(10);
      const lines = wrap(ask, WIDTH - 18);
      return {
        height: lines.length * 14 + 4, draw: top => {
          doc.setDrawColor(ink.faint);
          doc.setLineWidth(0.8);
          doc.roundedRect(LEFT, top + 2.6, 9, 9, 1.5, 1.5, "S");
          font(10, "normal", ink.text);
          write(lines, LEFT + 17, top, 14);
        },
      };
    }));
  }

  blocks("Check before acting", String(report.uncertainties.length), report.uncertainties.map(item => {
    font(9.5);
    const lines = wrap(item, WIDTH - 17);
    return {
      height: lines.length * 13.5 + 4, draw: top => {
        doc.setFillColor(tints.warn.text);
        doc.circle(LEFT + 4, top + 6.6, 2, "F");
        font(9.5, "normal", ink.body);
        write(lines, LEFT + 17, top, 13.5);
      },
    };
  }));

  blocks("Summary", "AI draft from the medic's words · verify", report.summary.map(item => {
    font(10.5);
    const lines = wrap(item.text, WIDTH);
    return {
      height: lines.length * 15.2 + 5, draw: top => {
        font(10.5, "normal", ink.body);
        write(lines, LEFT, top, 15.2);
      },
    };
  }));

  // The ER's questions and the medic's spoken answers, with what each answer changed.
  const messages = session.messages ?? [];
  blocks("Messages with the crew", String(messages.length), messages.map(message => {
    const er = message.from === "er";
    const added = Object.keys(message.added ?? {}).map(field => fieldLabels[field] ?? field);
    const parts: (Part & { size: number })[] = [
      { text: er ? `ER · ${time(message.at)}${message.heard_at ? ` · read aloud on the glasses at ${time(message.heard_at)}` : " · not read aloud yet"}`
        : `Medic · ${time(message.at)}`, size: 8, style: "bold", color: er ? tints.ok.text : ink.muted },
    ];
    if (message.clean || message.text) parts.push({ text: message.clean || message.text, size: 10, color: ink.text });
    if (message.clean) parts.push({ text: `As heard: “${message.heard || message.text}”`, size: 8.5, style: "italic", color: ink.muted });
    if (!er && message.vitals?.length) {
      const logged = message.vitals.map(vital => `${vitalKinds.find(item => item.kind === vital.kind)!.short} ${vital.value}`);
      parts.push({ text: `Logged: ${logged.join(" · ")}`, size: 8, style: "bold", color: tints.info.text });
    }
    if (!er && added.length) parts.push({ text: `Added to the handover: ${added.join(", ")}`, size: 8, style: "bold", color: tints.ok.text });
    if (message.photo) parts.push({ text: "Sent a photo, shown with the photos below.", size: 8, color: ink.muted });
    const measured = parts.map(part => {
      font(part.size, part.style);
      return { ...part, lines: wrap(part.text, WIDTH - 12) };
    });
    const height = measured.reduce((sum, part) => sum + part.lines.length * part.size * 1.4, 0);
    return {
      height: height + 8, draw: top => {
        doc.setDrawColor(er ? ink.brand : ink.strong);
        doc.setLineWidth(2);
        doc.line(LEFT + 1, top + 1, LEFT + 1, top + height - 1);
        let line = top;
        for (const part of measured) {
          font(part.size, part.style, part.color);
          write(part.lines, LEFT + 12, line, part.size * 1.4);
          line += part.lines.length * part.size * 1.4;
        }
      },
    };
  }));

  blocks("Timeline", "Minutes and seconds after “start”", report.timeline.map(entry => {
    font(10, "bold");
    const title = wrap(entry.title, WIDTH - 46);
    font(9.5);
    const detail = wrap(entry.detail, WIDTH - 46);
    return {
      height: title.length * 13.5 + detail.length * 13 + 6, draw: top => {
        font(9, "bold", ink.muted);
        doc.text(clock(entry.seconds), LEFT, top + 9.55);
        font(10, "bold", ink.text);
        write(title, LEFT + 46, top, 13.5);
        font(9.5, "normal", ink.body);
        write(detail, LEFT + 46, top + title.length * 13.5, 13);
      },
    };
  }));

  // Photos two to a row, each with its caption.
  const columnGap = 12;
  const cell = (WIDTH - columnGap) / 2;
  const frame = cell * 0.75;
  const pairs = Array.from({ length: Math.ceil(shots.length / 2) }, (_, index) => shots.slice(index * 2, index * 2 + 2));
  blocks("Injury photos", String(shots.length), pairs.map(pair => {
    font(8.5);
    const captions = pair.map(shot => shot.caption ? wrap(shot.caption, cell).slice(0, 4) : []);
    return {
      height: frame + 22 + Math.max(...captions.map(lines => lines.length)) * 11.5 + 12, draw: top => pair.forEach((shot, column) => {
        const x = LEFT + column * (cell + columnGap);
        doc.setFillColor(ink.wash);
        doc.roundedRect(x, top, cell, frame, 4, 4, "F");
        // The whole photo, never cropped: the edge of a wound matters.
        const scale = Math.min(cell / shot.image.width, frame / shot.image.height);
        const width = shot.image.width * scale;
        const tall = shot.image.height * scale;
        doc.addImage(shot.image.data, "JPEG", x + (cell - width) / 2, top + (frame - tall) / 2, width, tall);
        font(8, "normal", ink.muted);
        const when = plain(shot.when);
        const whenWidth = doc.getTextWidth(when);
        doc.text(when, x + cell, top + frame + 14, { align: "right" });
        font(8.5, "bold", ink.text);
        doc.text(fit(shot.label, cell - whenWidth - 8), x, top + frame + 14);
        font(8.5, "normal", ink.body);
        write(captions[column], x, top + frame + 19, 11.5);
      }),
    };
  }));

  // Running header and footer on every page, now that the page count is known.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    if (page > 1) {
      wordmark(LEFT, TOP + 12, 12);
      font(8, "normal", ink.muted);
      doc.text(fit(`${patient} · Handover`, WIDTH - 110), LEFT + WIDTH, TOP + 12, { align: "right" });
      rule(TOP + 20, ink.strong);
    }
    rule(PAGE.height - 40);
    font(7.5, "normal", ink.muted);
    doc.text(plain("Inbound · Drafted by AI from the crew’s spoken handover and photos. Verify with the crew before acting."), LEFT, PAGE.height - 28);
    doc.text(`Ref ${session.id.slice(0, 8)} · Page ${page} of ${pages}`, LEFT + WIDTH, PAGE.height - 28, { align: "right" });
  }

  const pad = (number: number) => String(number).padStart(2, "0");
  const stamp = `${made.getFullYear()}-${pad(made.getMonth() + 1)}-${pad(made.getDate())}-${pad(made.getHours())}${pad(made.getMinutes())}`;
  const slug = patient.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return { blob: doc.output("blob"), name: `inbound-handover-${slug}-${stamp}.pdf` };
}
