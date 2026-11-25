import { describe, expect, test } from "vitest";
import { THUMB_BOXES, thumbnail, when } from "../src/display.ts";
import { inZone } from "./admin-fixtures.ts";

describe("when", () => {
  test.each([
    {
      label: "UTC morning",
      zone: "UTC",
      iso: "2026-11-10T09:05:00Z",
      pattern: /^10 Nov(?: at|,) 09:05$/,
    },
    {
      label: "Berlin winter time",
      zone: "Europe/Berlin",
      iso: "2026-01-10T09:05:00Z",
      pattern: /^10 Jan(?: at|,) 10:05$/,
    },
  ])("formats a timestamp in $label", ({ zone, iso, pattern }) => {
    const formatted = inZone(zone, () => when(Date.parse(iso)));
    expect(formatted).toMatch(pattern);
  });
});

describe("thumbnail", () => {
  test("builds 1x and 2x image attributes from THUMB_BOXES widths", () => {
    const href = "file:///sample/docs/a%20b.png";
    expect(THUMB_BOXES).toEqual([
      [480, 270],
      [960, 540],
    ]);
    expect(thumbnail(href)).toEqual({
      src: `${href}?w=480`,
      srcset: `${href}?w=480 480w, ${href}?w=960 960w`,
      sizes: "auto, 50vw",
    });
  });
});
