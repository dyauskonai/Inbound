import type { Command, Phase } from "./channels";

export function normalizeSpeech(text: string): string {
  return text.toLowerCase().trim().replace(/^\p{P}+|\p{P}+$/gu, "").trim().replace(/\s+/g, " ");
}

// Narrative containing these words must not interrupt a recording.
export function commandFrom(text: string): Command | null {
  const phrase = normalizeSpeech(text);
  if (/^start(?: (?:the )?record(?:ings?)?)?$/.test(phrase)) return "start";
  if (/^stop(?: (?:the )?record(?:ings?)?)?$/.test(phrase)) return "stop";
  if (/^(?:take a )?(?:snap|snapshot|screen\s?shot)$/.test(phrase)) return "snap";
  return null;
}

export function canStartCapture(phase: Phase): boolean {
  return phase === "ready" || phase === "complete" || phase === "awaiting_key";
}

export function serverOrigin(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/device\/[a-f0-9]{64})?$/i.test(value)) {
    throw new Error("Enter the Mac address, such as http://192.168.1.20:8000");
  }
  return value;
}
