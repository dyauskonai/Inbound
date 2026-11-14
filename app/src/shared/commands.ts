import type { Command } from "./channels";

// Narrative containing these words must not interrupt a recording.
export function commandFrom(text: string): Command | null {
  const phrase = text.toLowerCase().replace(/[.!?,]/g, "").trim().replace(/\s+/g, " ");
  if (phrase === "start" || phrase === "start recording") return "start";
  if (phrase === "stop" || phrase === "stop recording") return "stop";
  if (phrase === "snap") return "snap";
  return null;
}

export function serverOrigin(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/device\/[a-f0-9]{64})?$/i.test(value)) {
    throw new Error("Enter the Mac address, such as http://192.168.1.20:8000");
  }
  return value;
}
