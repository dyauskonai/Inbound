import type { Handoff, Vital, VitalKind } from "./data";

export const vitalKinds: { kind: VitalKind; label: string; short: string; unit: string; field: keyof Handoff }[] = [
  { kind: "bp", label: "Blood pressure", short: "BP", unit: "mmHg", field: "blood_pressure" },
  { kind: "hr", label: "Heart rate", short: "HR", unit: "bpm", field: "heart_rate" },
  { kind: "spo2", label: "SpO₂", short: "SpO₂", unit: "%", field: "spo2" },
  { kind: "rr", label: "Resp. rate", short: "RR", unit: "/min", field: "respiratory_rate" },
];

/**
 * NEWS2 points for one adult observation (Royal College of Physicians bands; SpO₂ scale 1).
 * 3 is a red band, 1–2 amber, 0 normal. Highlighting only, never a score or a diagnosis.
 */
export function news2(kind: VitalKind, value: string): 0 | 1 | 2 | 3 | null {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return null;
  if (kind === "bp") return number <= 90 || number >= 220 ? 3 : number <= 100 ? 2 : number <= 110 ? 1 : 0;
  if (kind === "hr") return number <= 40 || number >= 131 ? 3 : number >= 111 ? 2 : number <= 50 || number >= 91 ? 1 : 0;
  if (kind === "rr") return number <= 8 || number >= 25 ? 3 : number >= 21 ? 2 : number <= 11 ? 1 : 0;
  return number <= 91 ? 3 : number <= 93 ? 2 : number <= 95 ? 1 : 0;
}

export type Severity = "critical" | "abnormal" | "normal" | "unknown";
export const severity = (points: number | null): Severity =>
  points === null ? "unknown" : points >= 3 ? "critical" : points >= 1 ? "abnormal" : "normal";

export interface VitalView {
  kind: VitalKind;
  /** What to show: one value, or both values while the medic hasn't settled it. */
  value: string | null;
  candidates: string[];
  status: Vital["status"] | "reported";
  points: 0 | 1 | 2 | 3 | null;
  /** Earlier readings in this capture, oldest first, for the trend line. */
  history: { value: string; seconds: number }[];
}

// The phone's logged vitals are the latest truth; the report's card fills any gaps.
export function vitalViews(vitals: Vital[] = [], handoff?: Handoff | null): VitalView[] {
  return vitalKinds.map(({ kind, field }) => {
    const events = vitals.filter(vital => vital.kind === kind);
    const last = events.at(-1);
    const readings = events.filter(vital => vital.value && vital.status !== "conflict" && vital.status !== "unconfirmed");
    const history = readings.map(vital => ({ value: vital.value, seconds: vital.seconds }))
      .filter((reading, index, all) => index === 0 || reading.value !== all[index - 1].value);
    if (last) {
      const unsettled = last.status === "conflict" || last.status === "unconfirmed";
      const shown = unsettled ? null : last.value;
      return { kind, value: shown, candidates: unsettled ? last.candidates : [], status: last.status, points: shown ? news2(kind, shown) : null, history };
    }
    const reported = handoff?.[field] as string | null | undefined;
    if (reported && /unconfirmed/.test(reported)) {
      const candidates = reported.replace(" (unconfirmed)", "").replace(/%/g, "").split(" or ");
      return { kind, value: null, candidates, status: "unconfirmed", points: null, history: [] };
    }
    const value = reported ? reported.replace("%", "") : null;
    const confirmed = handoff?.confirmed_fields?.includes(field as string) ? "confirmed" : handoff?.updated_fields?.includes(field as string) ? "updated" : "reported";
    return { kind, value, candidates: [], status: confirmed, points: value ? news2(kind, value) : null, history: [] };
  });
}
