import type { Command } from "./channels";

export function normalizeSpeech(text: string): string {
  return text.toLowerCase().trim().replace(/^\p{P}+|\p{P}+$/gu, "").trim().replace(/\s+/g, " ");
}

export function speechWords(text: string): string[] {
  return text.toLowerCase().replace(/[’‘]/g, "'").split(/[^a-z0-9']+/).map(word => word.replace(/^'+|'+$/g, "")).filter(Boolean);
}

const keywords: Record<string, Command> = { start: "start", stop: "stop", snap: "snap", snapshot: "snap", screenshot: "snap" };
// "Don't stop" must not end a recording.
const negations = new Set(["don't", "dont", "not", "never", "cannot", "can't", "cant", "won't", "wont", "shouldn't"]);

export interface CommandHit {
  command: Command;
  /** Position of the command word in the hypothesis. */
  index: number;
  /** 1 for the first "snap" in the utterance, 2 for the second, and so on. */
  occurrence: number;
}

// Commands can appear anywhere in a sentence: "okay start recording now".
export function findCommands(words: string[]): CommandHit[] {
  const hits: CommandHit[] = [];
  const seen = new Map<Command, number>();
  words.forEach((word, index) => {
    const command = keywords[word] ?? (word === "screen" && words[index + 1] === "shot" ? "snap" : undefined);
    if (!command || negations.has(words[index - 1] ?? "")) return;
    const occurrence = (seen.get(command) ?? 0) + 1;
    seen.set(command, occurrence);
    hits.push({ command, index: word === "screen" ? index + 1 : index, occurrence });
  });
  return hits;
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
