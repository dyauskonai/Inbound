import { expect, test } from "bun:test";
import { findVitals, spokenValue } from "../src/shared/vitals";

const read = (text: string, expect?: Parameters<typeof findVitals>[1]) =>
  findVitals(text, expect).map(vital => `${vital.kind} ${vital.value}`);

test("vitals said with keywords, in digits or words", () => {
  expect(read("BP 190/60, heart rate 110, sats 98%")).toEqual(["bp 190/60", "hr 110", "spo2 98"]);
  expect(read("blood pressure one ninety over sixty")).toEqual(["bp 190/60"]);
  expect(read("b p ninety over sixty heart rate one ten")).toEqual(["bp 90/60", "hr 110"]);
  expect(read("pulse is about a hundred and twelve")).toEqual(["hr 112"]);
  expect(read("s p o two ninety eight percent resp rate sixteen")).toEqual(["spo2 98", "rr 16"]);
  expect(read("pulse ox a hundred")).toEqual(["spo2 100"]);
  expect(read("pressure one oh five over seventy")).toEqual(["bp 105/70"]);
});

test("a correction gives both values in the order they were said", () => {
  expect(read("BP one ninety over sixty, correction, ninety over sixty")).toEqual(["bp 190/60", "bp 90/60"]);
  expect(read("sats ninety two, no, ninety eight")).toEqual(["spo2 92", "spo2 98"]);
  expect(read("heart rate one ten, I mean one twenty")).toEqual(["hr 110", "hr 120"]);
  expect(read("resp rate twelve, make that sixteen")).toEqual(["rr 12", "rr 16"]);
  // "No" followed by something else is not a correction.
  expect(read("heart rate one ten, no allergies, no twelve lead")).toEqual(["hr 110"]);
});

test("ordinary speech and implausible numbers are not vitals", () => {
  expect(read("age thirty two, fell over the curb, pain two over ten")).toEqual([]);
  expect(read("heart rate one")).toEqual([]);
  expect(read("put pressure on the wound")).toEqual([]);
  expect(read("we sat him down")).toEqual([]);
});

test("an answer to a repeat request can be just the number", () => {
  expect(read("one ten", "hr")).toEqual(["hr 110"]);
  expect(read("ninety over sixty", "bp")).toEqual(["bp 90/60"]);
  expect(read("okay", "hr")).toEqual([]);
});

test("values are read back the way people say them", () => {
  expect(spokenValue("bp", "90/60")).toBe("90 over 60");
  expect(spokenValue("spo2", "98")).toBe("98 percent");
});
