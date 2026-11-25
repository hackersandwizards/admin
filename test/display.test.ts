import { describe, expect, test } from "vitest";
import { THUMB_BOXES, when } from "../src/display.ts";
import { inZone } from "./admin-fixtures.ts";

describe("when", () => {
  test("formats a timestamp in a non-UTC local time zone", () => {
    const formatted = inZone("Europe/Berlin", () => when(Date.parse("2026-01-10T09:05:00Z")));
    expect(formatted).toMatch(/^10 Jan(?: at|,) 10:05$/);
  });
});

describe("THUMB_BOXES", () => {
  test("defines 16:9 dimensions for 1x and 2x thumbnails", () => {
    expect(THUMB_BOXES).toEqual([
      [480, 270],
      [960, 540],
    ]);
  });
});
