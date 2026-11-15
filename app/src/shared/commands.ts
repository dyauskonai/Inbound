import type { Command } from "./channels";

export function normalizeSpeech(text: string): string {
  return text.toLowerCase().trim().replace(/^\p{P}+|\p{P}+$/gu, "").trim().replace(/\s+/g, " ");
}

export function speechWords(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").split(/[^a-z0-9']+/).map(word => word.replace(/^'+|'+$/g, "")).filter(Boolean);
}

// "Snap" is rare in conversation, so it works alone. "Start" and "stop" are everyday words ("we had to stop the
// bleeding"), so they count only after "inbound": "inbound start", "inbound stop".
const keywords = new Map<string, Command>([["snap", "snap"], ["snapshot", "snap"], ["screenshot", "snap"]]);
const wakeCommands = new Map<string, Command>([["start", "start"], ["stop", "stop"]]);
const wakeWords = new Set(["inbound", "inbounds", "inbound's"]);
/** What the medic says for each command. */
export const commandPhrases: Record<Command, string> = { start: "inbound start", snap: "snap", stop: "inbound stop" };
// A negated command, like "don't snap", doesn't count.
const negations = new Set(["don't", "dont", "not", "never", "cannot", "can't", "cant", "won't", "wont", "shouldn't"]);

export interface CommandHit {
  command: Command;
  /** Position of the command word in the hypothesis. */
  index: number;
  /** 1 for the first "snap" in the utterance, 2 for the second, and so on. */
  occurrence: number;
}

// Commands can appear anywhere in a sentence: "okay inbound start, patient is 45".
export function findCommands(words: string[]): CommandHit[] {
  const hits: CommandHit[] = [];
  const seen = new Map<Command, number>();
  words.forEach((word, index) => {
    let command: Command | undefined = keywords.get(word) ?? (word === "screen" && words[index + 1] === "shot" ? "snap" : undefined);
    // Where the phrase begins: "inbound start", or "in bound start" as the recognizer may split it.
    let first = index;
    const woken = wakeCommands.get(word);
    if (!command && woken) {
      first = wakeWords.has(words[index - 1] ?? "") ? index - 1 : words[index - 2] === "in" && words[index - 1] === "bound" ? index - 2 : -1;
      if (first >= 0) command = woken;
    }
    if (!command || negations.has(words[first - 1] ?? "")) return;
    const occurrence = (seen.get(command) ?? 0) + 1;
    seen.set(command, occurrence);
    hits.push({ command, index: word === "screen" ? index + 1 : index, occurrence });
  });
  return hits;
}

/** A reply's words without the commands that steered it: "penicillin, inbound stop" is "penicillin". */
export function withoutCommands(text: string): string {
  return text.replace(/\b(?:snap(?:shot)?|screen ?shot|in[\s-]?bound(?:'?s)?[\s,.]*(?:start|stop))\b[.,!?]?/gi, " ").replace(/\s+/g, " ").trim();
}

export function commandFrom(text: string): Command | null {
  return findCommands(speechWords(text))[0]?.command ?? null;
}

export function isPhoneRelay(address: string): boolean {
  return /\/device\/[a-f0-9]{64}$/i.test(address);
}

export function serverOrigin(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/device\/[a-f0-9]{64})?$/i.test(value)) {
    throw new Error("Enter the Mac address, such as http://192.168.1.20:8000");
  }
  return value;
}
