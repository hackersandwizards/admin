import { describe, expect, test } from "vitest";
import {
  ItemError,
  compareItems,
  parseFrontmatter,
  splitItemBody,
  type Item,
} from "../src/items.ts";

const baseDecision: Item = {
  id: "pick-option",
  kind: "decision",
  status: "open",
  priority: 2,
  owner: "Alex",
  options: [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ],
  title: "Pick an option",
  body: "",
};

describe("parseFrontmatter", () => {
  test.each([
    ["valid mapping", "kind: goal\nstatus: open\n", { kind: "goal", status: "open" }],
    ["empty document", "", {}],
  ])("parses %s into a frontmatter object", (_label, yaml, expected) => {
    expect(parseFrontmatter(yaml)).toEqual(expected);
  });

  test.each([
    ["invalid YAML syntax", "[unfinished", /^frontmatter:/],
    ["sequence instead of mapping", "[work, open]", "frontmatter is not a mapping"],
    ["scalar instead of mapping", "work", "frontmatter is not a mapping"],
    ["unknown fields", "colour: red\nsize: big", "unknown field colour, size"],
    ["repeated top-level field", 'kind: work\n"kind": review', "repeated field kind"],
  ])("rejects %s with an ItemError", (_label, yaml, message) => {
    expect(() => parseFrontmatter(yaml)).toThrow(ItemError);
    expect(() => parseFrontmatter(yaml)).toThrow(message);
  });
});

describe("splitItemBody", () => {
  test.each([
    [
      "heading followed by prose",
      "\n# Ship it\n\nDetails here.\n",
      { title: "Ship it", body: "Details here." },
    ],
    ["heading at end of file", "\n#  Finish  ", { title: "Finish", body: "" }],
    [
      "Unicode line separator inside heading",
      "\n# Draft \u2028!\n\n",
      { title: "Draft \u2028!", body: "" },
    ],
  ])("extracts title and trimmed body for %s", (_label, markdown, expected) => {
    expect(splitItemBody(markdown)).toEqual(expected);
  });

  test.each([
    ["prose before heading", "Intro first.\n# Title"],
    ["blank heading", "#  \t\n\nBody"],
  ])("rejects %s without a leading heading", (_label, markdown) => {
    expect(() => splitItemBody(markdown)).toThrow(
      new ItemError('body does not start with "# <title>"'),
    );
  });
});

describe("compareItems tie-breaking", () => {
  test.each([
    [
      "non-work kinds tie on kind and fall through to order",
      { ...baseDecision, id: "rev", kind: "review" as const, order: 1 },
      { ...baseDecision, id: "dec", kind: "decision" as const, order: 2 },
    ],
    [
      "positive change timestamp ranks ahead of missing timestamp",
      { ...baseDecision, id: "older-id", changed: 100 },
      { ...baseDecision, id: "alpha-id", changed: undefined },
    ],
  ])("%s", (_label, first, second) => {
    expect(compareItems(first, second)).toBeLessThan(0);
    expect(compareItems(second, first)).toBeGreaterThan(0);
  });
});
