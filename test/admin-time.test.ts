import { describe, expect, test } from "vitest";
import { clockTime, shortDateTime } from "../site/src/time.ts";

describe("time formatting", () => {
  const localMorning = new Date(2026, 0, 5, 9, 4);

  test.each([
    { label: "ISO string", input: localMorning.toISOString(), expected: "09:04" },
    { label: "epoch milliseconds", input: localMorning.getTime(), expected: "09:04" },
  ])("clockTime formats $label as 24-hour HH:MM", ({ input, expected }) => {
    expect(clockTime(input)).toBe(expected);
  });

  test.each([
    { label: "ISO string", input: localMorning.toISOString(), expected: "5 Jan at 09:04" },
    { label: "epoch milliseconds", input: localMorning.getTime(), expected: "5 Jan at 09:04" },
  ])("shortDateTime formats $label as day, short month, and HH:MM", ({ input, expected }) => {
    expect(shortDateTime(input)).toBe(expected);
  });
});
