import { describe, expect, test } from "vitest";
import {
  ItemError,
  compareItems,
  imagePath,
  itemRankKey,
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

describe("itemRankKey", () => {
  test.each([
    [
      "minimal goal defaults missing rank fields",
      { id: "ship", kind: "goal" as const, status: "open" as const, title: "Ship", body: "" },
      [9, "9999-12-32", 0, 1e9, "9999-12-32", 0, "ship"],
    ],
    [
      "due-soon work item carries due date in soon slot and negates positive change time",
      {
        ...baseDecision,
        id: "task",
        kind: "work" as const,
        priority: 1,
        order: 5,
        due: "2000-01-01",
        changed: 42,
      },
      [1, "2000-01-01", 1, 5, "2000-01-01", -42, "task"],
    ],
    [
      "far-future review keeps sentinel in soon slot and negates negative change time",
      {
        ...baseDecision,
        id: "check",
        kind: "review" as const,
        priority: 3,
        order: 0,
        due: "2099-06-15",
        changed: -10,
      },
      [3, "9999-12-32", 0, 0, "2099-06-15", 10, "check"],
    ],
  ])("builds the ordered key for %s", (_label, item, expected) => {
    expect(itemRankKey(item)).toEqual(expected);
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
    [
      "two items with Infinity order fall through to id instead of returning NaN",
      { ...baseDecision, id: "alpha", order: Number.POSITIVE_INFINITY },
      { ...baseDecision, id: "beta", order: Number.POSITIVE_INFINITY },
    ],
  ])("%s", (_label, first, second) => {
    expect(compareItems(first, second)).toBeLessThan(0);
    expect(compareItems(second, first)).toBeGreaterThan(0);
  });
});

describe("imagePath", () => {
  test.each([
    {
      label: "bare filename resolves under item folder",
      id: "pick",
      src: "a.png",
      expected: "docs/agent-work/items/pick/a.png",
    },
    {
      label: "path with slash stays relative to repo root",
      id: "pick",
      src: "docs/a.png",
      expected: "docs/a.png",
    },
  ])("$label", ({ id, src, expected }) => {
    expect(imagePath(id, src)).toBe(expected);
  });
});
