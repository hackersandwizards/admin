import { describe, expect, test } from "vitest";
import type { Item } from "../src/items.ts";
import {
  coreFieldDefects,
  dueDefects,
  imageDefects,
  imageEntryDefect,
  itemDefects,
  openDecisionDefects,
  openKindDefects,
  optionEntryDefect,
  optionScoreDefects,
  parseNeeds,
  parseOptions,
  parseRecommended,
  priorityDefects,
  recommendationDefects,
  settledStatusDefects,
  textFieldDefects,
  topicDefects,
  usableImages,
} from "../src/item-validation.ts";

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

describe("itemDefects ordering", () => {
  test("reports defects across all field groups in order on one defective decision", () => {
    const broken = {
      id: "Bad_Id",
      kind: "decision",
      status: "open",
      priority: 9,
      order: "first",
      area: { nested: 1 },
      evidence: [],
      due: "2026-02-30",
      topic: "2026-01-15-missing",
      needs: [1, "dep", "dep"],
      multiple: false,
      recommended: ["a", "missing"],
      options: [
        { key: "a", label: "A", score: "high" },
        { key: "a", label: "A2", noise: 1 },
        { key: "b c", label: "BC" },
        { key: "d", label: { bad: true } },
        { key: "", label: "Blank key" },
      ],
      images: {
        a: "missing.png",
        ghost: [{ src: 5 }],
      },
      title: "Broken",
      body: "",
    } as unknown as Item;

    expect(itemDefects(broken, () => false)).toEqual([
      "id Bad_Id is not lower-case kebab",
      "priority 9",
      "order first",
      "lacks owner",
      "area is not text",
      "evidence is not text",
      "due 2026-02-30 not ISO",
      "topic report docs/agent-work/2026-01-15-missing.md not found. Add the report or correct topic",
      "needs entry 1 must be a string. Use an item id",
      'needs has duplicate item "dep". Remove entry 3',
      'option 3 key "b c" is not one word',
      "option d label or detail is not text",
      "option 5 lacks key or label",
      "duplicate option key",
      "several recommended without multiple",
      "recommended missing is not an option",
      "option a score high is not a number",
      "option a noise without a numeric score",
      "image docs/agent-work/items/Bad_Id/missing.png not found",
      "image key ghost is not an option",
      'image {"src":5} is not a path or {src, caption}',
    ]);
  });

  test.each([
    [
      "goal with priority, non-plain topic, assumed status, non-list options, and scalar images",
      {
        id: "ship-it",
        kind: "goal",
        status: "assumed",
        priority: 2,
        topic: "draft",
        options: "a",
        images: "cover.png",
        title: "Ship",
        body: "",
      },
      [
        "goal has a priority",
        "topic must be a plain report name: YYYY-MM-DD- followed by lower-case letters, digits and hyphens, without .md. Rename the report or correct the field",
        "goal is assumed",
        "options is not a list",
        "assumed without assumption or recommended",
        "images is neither a list nor a mapping",
      ],
    ],
    [
      "open decision with one option and non-boolean multiple",
      {
        ...baseDecision,
        options: [{ key: "a", label: "A" }],
        multiple: "yes",
      },
      [
        "open decision with fewer than two options (a review request is kind: review)",
        "multiple yes is not true or false",
      ],
    ],
    [
      "decided work item without decision or decider",
      {
        ...baseDecision,
        kind: "work",
        status: "decided",
      },
      ["work is decided", "decided without decision or by"],
    ],
  ])("reports status and kind rules in order for %s", (_label, item, expected) => {
    expect(itemDefects(item as unknown as Item, () => true)).toEqual(expected);
  });
});

describe("priorityDefects", () => {
  test.each([
    { label: "goal without priority", kind: "goal" as const, priority: undefined, expected: [] },
    {
      label: "goal with priority",
      kind: "goal" as const,
      priority: 2,
      expected: ["goal has a priority"],
    },
    { label: "decision with priority 1", kind: "decision" as const, priority: 1, expected: [] },
    {
      label: "decision with priority 4",
      kind: "decision" as const,
      priority: 4,
      expected: ["priority 4"],
    },
    {
      label: "work without priority",
      kind: "work" as const,
      priority: undefined,
      expected: ["priority undefined"],
    },
  ])("checks $label", ({ kind, priority, expected }) => {
    expect(priorityDefects(kind, priority)).toEqual(expected);
  });
});

describe("coreFieldDefects", () => {
  test.each([
    ["valid goal without owner", { id: "ship-1", kind: "goal", status: "open" }, []],
    [
      "invalid id, kind, status, priority, order, and missing owner",
      { id: "Bad", kind: "task", status: "done", priority: 5, order: "soon" },
      [
        "id Bad is not lower-case kebab",
        "kind task",
        "status done",
        "priority 5",
        "order soon",
        "lacks owner",
      ],
    ],
  ])("checks %s", (_label, fields, expected) => {
    expect(coreFieldDefects(fields as unknown as Item)).toEqual(expected);
  });
});

describe("textFieldDefects", () => {
  test.each([
    ["string and numeric fields", { area: "ops", owner: 7, evidence: "ok" }, []],
    [
      "non-text area and quote",
      { area: { a: 1 }, quote: ["x"] },
      ["area is not text", "quote is not text"],
    ],
  ])("checks %s", (_label, fields, expected) => {
    expect(textFieldDefects(fields as unknown as Item)).toEqual(expected);
  });
});

describe("dueDefects", () => {
  test.each([
    ["absent due date", undefined, []],
    ["valid leap day", "2028-02-29", []],
    ["impossible calendar day", "2026-02-30", ["due 2026-02-30 not ISO"]],
    ["non-ISO date string", "3 Nov", ["due 3 Nov not ISO"]],
  ])("checks %s", (_label, due, expected) => {
    expect(dueDefects(due)).toEqual(expected);
  });
});

describe("topicDefects", () => {
  const existing = (path: string) => path === "docs/agent-work/2026-01-15-found.md";

  test.each([
    ["absent topic", undefined, []],
    ["existing plain report", "2026-01-15-found", []],
    [
      "non-plain report name",
      "2026-01-15-bad.md",
      [
        "topic must be a plain report name: YYYY-MM-DD- followed by lower-case letters, digits and hyphens, without .md. Rename the report or correct the field",
      ],
    ],
    [
      "missing plain report",
      "2026-01-15-absent",
      [
        "topic report docs/agent-work/2026-01-15-absent.md not found. Add the report or correct topic",
      ],
    ],
  ])("checks %s", (_label, topic, expected) => {
    expect(topicDefects(topic, existing)).toEqual(expected);
  });
});

describe("parseNeeds", () => {
  test.each([
    ["absent needs", undefined, { value: undefined, defects: [] }],
    [
      "scalar instead of list",
      "check",
      { value: undefined, defects: ["needs must be a list. Use a list of item ids"] },
    ],
    [
      "list with non-string and duplicate entries",
      ["a", 42, "a"],
      {
        value: ["a", "a"],
        defects: [
          "needs entry 2 must be a string. Use an item id",
          'needs has duplicate item "a". Remove entry 3',
        ],
      },
    ],
  ])("parses %s", (_label, raw, expected) => {
    expect(parseNeeds(raw)).toEqual(expected);
  });
});

describe("openKindDefects", () => {
  test.each([
    { label: "open work", kind: "work" as const, status: "open" as const, expected: [] },
    { label: "open goal", kind: "goal" as const, status: "open" as const, expected: [] },
    {
      label: "assumed work",
      kind: "work" as const,
      status: "assumed" as const,
      expected: ["work is assumed"],
    },
    {
      label: "decided goal",
      kind: "goal" as const,
      status: "decided" as const,
      expected: ["goal is decided"],
    },
    {
      label: "decided decision",
      kind: "decision" as const,
      status: "decided" as const,
      expected: [],
    },
  ])("checks $label", ({ kind, status, expected }) => {
    expect(openKindDefects(kind, status)).toEqual(expected);
  });
});

describe("openDecisionDefects", () => {
  test.each([
    {
      label: "open decision with one option",
      kind: "decision" as const,
      status: "open" as const,
      count: 1,
      expected: ["open decision with fewer than two options (a review request is kind: review)"],
    },
    {
      label: "open decision with two options",
      kind: "decision" as const,
      status: "open" as const,
      count: 2,
      expected: [],
    },
    {
      label: "open review with no options",
      kind: "review" as const,
      status: "open" as const,
      count: 0,
      expected: [],
    },
    {
      label: "decided decision with no options",
      kind: "decision" as const,
      status: "decided" as const,
      count: 0,
      expected: [],
    },
  ])("checks $label", ({ kind, status, count, expected }) => {
    expect(openDecisionDefects(kind, status, count)).toEqual(expected);
  });
});

describe("optionEntryDefect", () => {
  test.each([
    {
      label: "valid string option",
      option: { key: "a", label: "Alpha", detail: "Note" },
      index: 0,
      expected: undefined,
    },
    {
      label: "numeric key and detail",
      option: { key: 0, label: "Zero", detail: 9 },
      index: 0,
      expected: undefined,
    },
    { label: "null entry", option: null, index: 0, expected: "option 1 lacks key or label" },
    {
      label: "empty label",
      option: { key: "a", label: "" },
      index: 1,
      expected: "option 2 lacks key or label",
    },
    {
      label: "key with comma",
      option: { key: "a,b", label: "AB" },
      index: 0,
      expected: 'option 1 key "a,b" is not one word',
    },
    {
      label: "non-text detail",
      option: { key: "a", label: "Alpha", detail: ["list"] },
      index: 0,
      expected: "option a label or detail is not text",
    },
  ])("checks $label", ({ option, index, expected }) => {
    expect(optionEntryDefect(option, index)).toBe(expected);
  });
});

describe("parseOptions", () => {
  test.each([
    ["undefined options", undefined, { value: undefined, keys: [], defects: [] }],
    ["non-list options", "a", { value: undefined, keys: [], defects: ["options is not a list"] }],
    [
      "mixed valid, malformed, and duplicate options",
      [null, { key: 0, label: { bad: true }, detail: 7 }, { key: "0", label: "Zero" }],
      {
        value: [
          { key: "0", label: "0", detail: "7" },
          { key: "0", label: "Zero", detail: undefined },
        ],
        keys: [undefined, "0", "0"],
        defects: [
          "option 1 lacks key or label",
          "option 0 label or detail is not text",
          "duplicate option key",
        ],
      },
    ],
  ])("parses %s", (_label, raw, expected) => {
    expect(parseOptions(raw)).toEqual(expected);
  });
});

describe("parseRecommended", () => {
  test.each([
    ["undefined", undefined, undefined],
    ["null", null, undefined],
    ["single string", "a", ["a"]],
    ["numeric key", 1, ["1"]],
    ["list of keys", ["a", 2], ["a", "2"]],
  ])("normalizes %s", (_label, raw, expected) => {
    expect(parseRecommended(raw)).toEqual(expected);
  });
});

describe("recommendationDefects", () => {
  test.each([
    {
      label: "single valid option",
      recommended: "a",
      multiple: undefined,
      keys: ["a", "b"],
      expected: [],
    },
    {
      label: "multiple valid options when allowed",
      recommended: ["a", "b"],
      multiple: true,
      keys: ["a", "b"],
      expected: [],
    },
    {
      label: "non-boolean multiple flag",
      recommended: "a",
      multiple: "yes",
      keys: ["a"],
      expected: ["multiple yes is not true or false"],
    },
    {
      label: "several recommended without multiple and unknown option",
      recommended: ["a", "z"],
      multiple: false,
      keys: ["a", "b"],
      expected: ["several recommended without multiple", "recommended z is not an option"],
    },
  ])("checks $label", ({ recommended, multiple, keys, expected }) => {
    expect(recommendationDefects(recommended, multiple, keys)).toEqual(expected);
  });
});

describe("optionScoreDefects", () => {
  test.each([
    ["non-array", "a", []],
    ["valid score and noise", [{ key: "a", score: 8.4, noise: 0.5 }], []],
    [
      "non-numeric score and noise without score",
      [
        { key: "a", score: "8" },
        { key: "b", noise: 0.5 },
        { key: "c", score: 7, noise: "low" },
      ],
      [
        "option a score 8 is not a number",
        "option b noise without a numeric score",
        "option c noise without a numeric score",
      ],
    ],
  ])("checks %s", (_label, options, expected) => {
    expect(optionScoreDefects(options)).toEqual(expected);
  });
});

describe("settledStatusDefects", () => {
  test.each([
    ["open item", { status: "open" }, []],
    ["assumed with assumption", { status: "assumed", assumption: "Hold" }, []],
    ["assumed with recommended", { status: "assumed", recommended: "a" }, []],
    ["assumed with neither", { status: "assumed" }, ["assumed without assumption or recommended"]],
    ["decided with decision and by", { status: "decided", decision: "Use A", by: "Alex" }, []],
    [
      "decided without by",
      { status: "decided", decision: "Use A" },
      ["decided without decision or by"],
    ],
    [
      "decided without decision",
      { status: "decided", by: "Alex" },
      ["decided without decision or by"],
    ],
  ])("checks %s", (_label, fields, expected) => {
    expect(settledStatusDefects(fields as Item)).toEqual(expected);
  });
});

describe("imageEntryDefect", () => {
  const existing = (path: string) =>
    path === "docs/agent-work/items/pick/a.png" || path === "docs/shared.png";

  test.each([
    ["existing bare file", "a.png", undefined],
    ["existing repo-relative path", "docs/shared.png", undefined],
    ["captioned existing file", { src: "a.png", caption: "Front" }, undefined],
    ["missing bare file", "missing.png", "image docs/agent-work/items/pick/missing.png not found"],
    [
      "unexpected extra key",
      { src: "a.png", alt: "x" },
      'image {"src":"a.png","alt":"x"} is not a path or {src, caption}',
    ],
    ["null entry", null, "image null is not a path or {src, caption}"],
  ])("checks %s", (_label, image, expected) => {
    expect(imageEntryDefect("pick", image, existing)).toBe(expected);
  });
});

describe("imageDefects", () => {
  const existing = (path: string) => path === "docs/agent-work/items/pick/a.png";

  test.each([
    { label: "undefined images", images: undefined, keys: ["a"], expected: [] },
    {
      label: "scalar images",
      images: "a.png",
      keys: ["a"],
      expected: ["images is neither a list nor a mapping"],
    },
    { label: "valid list", images: ["a.png"], keys: [], expected: [] },
    {
      label: "mapping with unknown option key and missing image",
      images: { a: "a.png", ghost: "missing.png" },
      keys: ["a"],
      expected: [
        "image key ghost is not an option",
        "image docs/agent-work/items/pick/missing.png not found",
      ],
    },
  ])("checks $label", ({ images, keys, expected }) => {
    expect(imageDefects({ id: "pick", images } as Item, keys, existing)).toEqual(expected);
  });
});

describe("usableImages", () => {
  test.each([
    ["scalar value", "a.png", undefined],
    ["null value", null, undefined],
    [
      "list filtering malformed entries",
      ["a.png", null, { src: 2 }, { src: "b.png" }],
      ["a.png", { src: "b.png" }],
    ],
    [
      "mapping wrapping strings and filtering malformed entries",
      { a: "a.png", b: [{ src: "b.png", caption: "B" }, null] },
      { a: ["a.png"], b: [{ src: "b.png", caption: "B" }] },
    ],
  ])("normalizes %s", (_label, images, expected) => {
    expect(usableImages(images)).toEqual(expected);
  });
});
