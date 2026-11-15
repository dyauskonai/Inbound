import { expect, test } from "bun:test";
import { findVitals, spokenValue } from "../src/shared/vitals";

const read = (text: string, expect?: Parameters<typeof findVitals>[1]) =>
  findVitals(text, expect).map(vital => `${vital.kind} ${vital.unclear ? "unclear" : vital.value}`);

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

test("ordinary speech is not a vital", () => {
  expect(read("age thirty two, fell over the curb, pain two over ten")).toEqual([]);
  expect(read("put pressure on the wound")).toEqual([]);
  expect(read("we sat him down, heart rate is regular")).toEqual([]);
  expect(read("on oxygen two liters, pulse ox reading in five minutes")).toEqual([]);
});

test("a number said for a vital that makes no sense is unclear, so the glasses can ask", () => {
  // From the glasses: the recognizer dropped "-ty" from "one ninety".
  expect(read("b p one nine over sixty are actually ninety over sixty")).toEqual(["bp unclear", "bp 90/60"]);
  expect(read("heart rate one")).toEqual(["hr unclear"]);
  expect(read("BP one twenty")).toEqual(["bp unclear"]);
});

test("digit-by-digit numbers", () => {
  expect(read("BP one nine zero over six zero, sats nine eight")).toEqual(["bp 190/60", "spo2 98"]);
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

test("vitals the recognizer mishears or names another way", () => {
  // A medic's reply on the glasses, as the phone heard it.
  expect(read("blood pressure one ten over seventy heart rate one sixty sas ninety six respiration fourteen"))
    .toEqual(["bp 110/70", "hr 160", "spo2 96", "rr 14"]);
  expect(read("stats ninety eight percent, respiration rate eighteen")).toEqual(["spo2 98", "rr 18"]);
  // Without a number after it, the word is not a vital.
  expect(read("her stats were stable on the way")).toEqual([]);
});

test("more ways the recognizer writes saturation and breathing", () => {
  expect(read("satch ninety eight")).toEqual(["spo2 98"]);
  expect(read("breathing at twelve")).toEqual(["rr 12"]);
  expect(read("he's barely breathing")).toEqual([]);
  // An unlikely number is unclear, but keeps what was heard so a repeat can confirm it.
  expect(findVitals("sats twenty")).toEqual([{ kind: "spo2", value: "", unclear: true, heard: "20" }]);
  expect(findVitals("blood pressure four hundred over fifty")).toEqual([{ kind: "bp", value: "", unclear: true, heard: "400/50" }]);
});
