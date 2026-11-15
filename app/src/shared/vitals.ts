// Critical vitals as the medic says them: "BP one ninety over sixty", "sats 98 percent".
export type VitalKind = "bp" | "hr" | "spo2" | "rr";
/**
 * `unclear`: a number was said for the vital but doesn't make sense ("BP one nine over sixty",
 * when the recognizer dropped "-ty"). The glasses ask about it rather than guess.
 */
/** `heard`: the number behind an unclear reading that was a clear number, just an unlikely one ("sats twenty"). */
export interface VitalReading { kind: VitalKind; value: string; unclear?: boolean; heard?: string }
export const UNCLEAR = "unclear";

export const vitalNames: Record<VitalKind, string> = {
  bp: "blood pressure", hr: "heart rate", spo2: "oxygen saturation", rr: "respiratory rate",
};

/** How the glasses say a value back: "90 over 60", "98 percent". */
export function spokenValue(kind: VitalKind, value: string): string {
  return kind === "bp" ? value.replace("/", " over ") : kind === "spo2" ? `${value} percent` : value;
}

const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// Longest phrases first, so "pulse ox" is oxygen and not heart rate.
const PHRASES: [string[], VitalKind][] = ([
  [["blood", "pressure"], "bp"], [["b", "p"], "bp"], [["bp"], "bp"], [["pressure"], "bp"],
  [["s", "p", "o", "two"], "spo2"], [["s", "p", "o", "2"], "spo2"], [["sp", "o2"], "spo2"], [["pulse", "ox"], "spo2"],
  [["pulse", "oximetry"], "spo2"], [["oxygen", "saturation"], "spo2"], [["oxygen", "sat"], "spo2"], [["o2", "sat"], "spo2"],
  [["o2", "sats"], "spo2"], [["spo2"], "spo2"], [["sats"], "spo2"], [["sat"], "spo2"], [["saturation"], "spo2"],
  [["oxygen"], "spo2"], [["o2"], "spo2"],
  // How the recognizer often hears "sats".
  [["sas"], "spo2"], [["sass"], "spo2"], [["stats"], "spo2"], [["satch"], "spo2"], [["satches"], "spo2"], [["sach"], "spo2"], [["sax"], "spo2"],
  [["heart", "rate"], "hr"], [["h", "r"], "hr"], [["hr"], "hr"], [["pulse"], "hr"], [["heart"], "hr"],
  [["respiratory", "rate"], "rr"], [["resp", "rate"], "rr"], [["breathing", "rate"], "rr"], [["respirations"], "rr"],
  [["respiration", "rate"], "rr"], [["respiration"], "rr"], [["breathing"], "rr"],
  [["respiratory"], "rr"], [["resp"], "rr"], [["r", "r"], "rr"], [["rr"], "rr"],
] as [string[], VitalKind][]).sort((a, b) => b[0].length - a[0].length);

// A number followed by one of these is a dose, duration, or flow, not a vital: "oxygen two liters".
const OTHER_UNITS = new Set(["liter", "liters", "litre", "litres", "l", "lpm", "minute", "minutes", "mins", "hour", "hours", "day", "days",
  "year", "years", "old", "mg", "milligrams", "mcg", "micrograms", "ml", "cc", "units", "kg", "kilos", "pounds", "lbs", "feet", "foot", "inches"]);
const FILLERS = new Set(["is", "was", "of", "at", "about", "around", "approximately", "roughly", "now", "currently", "the", "a", "an",
  "reading", "measured", "its", "it's", "it", "are", "like", "um", "uh", "ah", "rate", "s"]);
// "sats 92, no, 98": after one of these, a bare number is the vital just mentioned.
const CORRECTIONS = new Set(["no", "sorry", "correction", "actually", "mean", "make", "scratch", "rather"]);
const CORRECTION_FILLERS = new Set([...FILLERS, "that", "i", "make", "mean", "sorry", "no", "correction", "actually"]);

function tokens(text: string): string[] {
  return text.toLowerCase()
    .replace(/(\d)\s*\/\s*(\d)/g, "$1 over $2")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/).filter(Boolean);
}

type Read = { value: number; next: number } | null;

function belowHundred(t: string[], i: number): Read {
  const word = t[i];
  if (word in TENS) {
    const unit = UNITS[t[i + 1]];
    return unit ? { value: TENS[word] + unit, next: i + 2 } : { value: TENS[word], next: i + 1 };
  }
  if (word in TEENS) return { value: TEENS[word], next: i + 1 };
  if (word in UNITS && word !== "oh") return { value: UNITS[word], next: i + 1 };
  return null;
}

/** A number in digits or words: "190", "one ninety", "one hundred and ten", "ninety eight". */
export function readNumber(t: string[], i: number): Read {
  const word = t[i];
  if (word === undefined) return null;
  if (/^\d{1,3}$/.test(word)) return { value: Number(word), next: i + 1 };
  let hundreds = 0;
  let j = i;
  if ((word === "a" || word in UNITS) && t[i + 1] === "hundred") {
    hundreds = (word === "a" ? 1 : UNITS[word]) * 100;
    j = i + 2;
  } else if (word === "hundred") {
    hundreds = 100;
    j = i + 1;
  }
  if (hundreds) {
    const rest = belowHundred(t, t[j] === "and" ? j + 1 : j);
    return rest ? { value: hundreds + rest.value, next: rest.next } : { value: hundreds, next: j };
  }
  // Medics say hundreds the short way: "one ninety" is 190, "one oh five" is 105.
  if (word === "one" || word === "two") {
    const base = UNITS[word] * 100;
    if (t[i + 1] === "oh" && t[i + 2] in UNITS) return { value: base + UNITS[t[i + 2]], next: i + 3 };
    if (t[i + 1] in TENS || t[i + 1] in TEENS) {
      const rest = belowHundred(t, i + 1)!;
      return { value: base + rest.value, next: rest.next };
    }
  }
  // Digit by digit: "one nine zero" is 190, "nine eight" is 98.
  if (word in UNITS && t[i + 1] in UNITS) {
    let digits = "";
    let j = i;
    while (t[j] in UNITS && digits.length < 3) digits += UNITS[t[j++]];
    return { value: Number(digits), next: j };
  }
  return belowHundred(t, i);
}

// Implausible values are almost always a misheard word, not a reading.
function plausible(kind: VitalKind, first: number, second = 0): boolean {
  if (kind === "bp") return first >= 40 && first <= 300 && second >= 10 && second <= 200 && first > second;
  if (kind === "hr") return first >= 20 && first <= 250;
  if (kind === "spo2") return first >= 50 && first <= 100;
  return first >= 4 && first <= 70;
}

// A number right after a vital's name that doesn't make sense is unclear rather than ignored.
function readVital(t: string[], i: number, kind: VitalKind): { vital: VitalReading; next: number } | null {
  const first = readNumber(t, i);
  if (!first || OTHER_UNITS.has(t[first.next])) return null;
  const unclear = (next: number, heard?: string) => ({ vital: { kind, value: "", unclear: true, ...(heard ? { heard } : {}) }, next });
  if (kind === "bp") {
    if (!["over", "by", "slash"].includes(t[first.next])) return unclear(first.next);
    const second = readNumber(t, first.next + 1);
    if (!second) return unclear(first.next + 1);
    if (!plausible(kind, first.value, second.value)) return unclear(second.next, `${first.value}/${second.value}`);
    return { vital: { kind, value: `${first.value}/${second.value}` }, next: second.next };
  }
  if (!plausible(kind, first.value)) return unclear(first.next, String(first.value));
  return { vital: { kind, value: String(first.value) }, next: t[first.next] === "percent" ? first.next + 1 : first.next };
}

function phraseAt(t: string[], i: number): { kind: VitalKind; next: number } | null {
  for (const [words, kind] of PHRASES) {
    if (words.every((word, offset) => t[i + offset] === word)) return { kind, next: i + words.length };
  }
  return null;
}

/**
 * Vitals in the order they were said. A bare "X over Y" is a blood pressure.
 * `expect` reads an answer to "repeat the heart rate" that is just a number.
 */
export function findVitals(text: string, expect?: VitalKind): VitalReading[] {
  const t = tokens(text);
  const found: VitalReading[] = [];
  for (let i = 0; i < t.length;) {
    const phrase = phraseAt(t, i);
    if (phrase) {
      let j = phrase.next;
      while (FILLERS.has(t[j])) j++;
      const reading = readVital(t, j, phrase.kind);
      if (reading) found.push(reading.vital);
      i = reading ? reading.next : phrase.next;
      continue;
    }
    const previous = found.at(-1)?.kind;
    if (previous && previous !== "bp" && CORRECTIONS.has(t[i])) {
      let j = i + 1;
      while (CORRECTION_FILLERS.has(t[j])) j++;
      // Only a believable value counts here: "no twelve lead" is not a heart rate.
      const reading = readVital(t, j, previous);
      if (reading && !reading.vital.unclear) {
        found.push(reading.vital);
        i = reading.next;
        continue;
      }
    }
    // Without a vital's name, only a clear "X over Y" counts: "pain two over ten" is not a blood pressure.
    const bare = readVital(t, i, "bp");
    const clear = bare && !bare.vital.unclear ? bare : null;
    if (clear) found.push(clear.vital);
    i = clear ? clear.next : i + 1;
  }
  if (expect && !found.some(vital => vital.kind === expect)) {
    for (let i = 0; i < t.length; i++) {
      const reading = readVital(t, i, expect);
      if (reading) {
        found.push(reading.vital);
        break;
      }
    }
  }
  return found;
}
