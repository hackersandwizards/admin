import { describe, expect, test } from "vitest";
import { decodeEntity, entities } from "../src/entities.ts";

describe("decodeEntity", () => {
  test.each([
    ["named lowercase amp", "amp;", "&"],
    ["named uppercase AMP", "AMP;", "&"],
    ["named uppercase QUOT", "QUOT;", '"'],
    ["named lowercase lt", "lt;", "<"],
    ["named uppercase GT", "GT;", ">"],
    ["named lowercase apos", "apos;", "'"],
    ["decimal with semicolon", "#60;", "<"],
    ["decimal without semicolon", "#62", ">"],
    ["lowercase hex", "#x27;", "'"],
    ["uppercase hex without semicolon", "#X2f", "/"],
    ["code point clamped to max Unicode scalar", "#999999999;", String.fromCodePoint(0x10ffff)],
  ])("decodes %s", (_label, token, expected) => {
    expect(decodeEntity(token)).toBe(expected);
  });
});

describe("entities", () => {
  test.each([
    ["mixed numeric and named entities", "a&amp;b &#x27;c&#39; &LT;d&GT;", "a&b 'c' <d>"],
    ["double-encoded entity stays decoded once", "&amp;lt;", "&lt;"],
    [
      "mixed-case or uppercase APOS stays literal",
      "&Amp; &APOS; &unknown;",
      "&Amp; &APOS; &unknown;",
    ],
  ])("transforms %s", (_label, input, expected) => {
    expect(entities(input)).toBe(expected);
  });
});
