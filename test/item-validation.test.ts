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
      "Item id Bad_Id cannot be used as a valid item reference. Rename the Markdown file using lowercase ASCII letters, digits or hyphens and start the id with a letter or digit.",
      "Priority 9 cannot rank this item. Set priority to the number 1, 2 or 3.",
      "Order first cannot sort the item. Use a number for order or omit it.",
      "No one is assigned to move this item. Set owner in the frontmatter.",
      "area needs text for display. Use a string or number.",
      "evidence needs text for display. Use a string or number.",
      "Due date 2026-02-30 is unusable for sorting. Set due to a valid YYYY-MM-DD date.",
      "topic report docs/agent-work/2026-01-15-missing.md not found. Add the report or correct topic",
      "needs entry 1 must be a string. Use an item id",
      'needs has duplicate item "dep". Remove entry 3',
      'Option 3 has an invalid reference key "b c". Set its key to a string or number without whitespace or commas.',
      "The hub needs text to display the label and detail for option d. Set label and any detail to strings or numbers.",
      "Option 5 needs a key for references and a label to display. Fill in both fields on that options entry.",
      "Duplicate option keys make references ambiguous. Give each options entry a unique key and update any recommended or images references to the renamed key.",
      "Multiple picks need opt-in. Set multiple to true or keep one recommendation.",
      "Recommended key missing has no choice. Use an option key in recommended.",
      "Option a has a score of high, which cannot be used as a numeric review score. Set score to a number.",
      "Noise requires a score for option a. Set both to numbers or omit noise.",
      "The hub cannot display image docs/agent-work/items/Bad_Id/missing.png. Add the missing file or fix its path in images.",
      "Image key ghost has no matching choice. Use a key from options in the images mapping or use an images list for the item as a whole.",
      'The hub cannot read the image entry {"src":5}. Use a path string or an object with a string src and an optional string caption.',
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
        "Goals must use the default priority. Remove priority from the frontmatter.",
        "topic must be a plain report name: YYYY-MM-DD- followed by lower-case letters, digits and hyphens, without .md. Rename the report or correct the field",
        "A goal item has status assumed. Set status to open, the only state for work and goals.",
        "Choices need a list. Write options as YAML list entries with key and label.",
        "The hub shows what was assumed. Fill in assumption or recommended.",
        "The hub groups images by item or option. Use a list or mapping in images.",
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
        "An open decision needs at least two options for a choice. Add entries under options or set kind to review for a review request.",
        "Multiple value yes does not specify whether several choices are allowed. Set multiple to true or false in the frontmatter.",
      ],
    ],
    [
      "decided work item without decision or decider",
      {
        ...baseDecision,
        kind: "work",
        status: "decided",
      },
      [
        "A work item has status decided. Set status to open, the only state for work and goals.",
        "Record what was decided and who decided it. Fill in decision and by.",
      ],
    ],
  ])("reports status and kind rules in order for %s", (_label, item, expected) => {
    expect(itemDefects(item as unknown as Item, () => true)).toEqual(expected);
  });

  test("checks core fields before reading options", () => {
    const item = {
      ...baseDecision,
      priority: {
        toString() {
          throw new Error("core-first");
        },
      },
      options: [
        {
          key: {
            toString() {
              throw new Error("options-first");
            },
          },
          label: "A",
        },
      ],
    } as unknown as Item;
    expect(() => itemDefects(item, () => true)).toThrow("core-first");
  });
});

describe("priorityDefects", () => {
  test.each([
    { label: "goal without priority", kind: "goal" as const, priority: undefined, expected: [] },
    {
      label: "goal with priority",
      kind: "goal" as const,
      priority: 2,
      expected: ["Goals must use the default priority. Remove priority from the frontmatter."],
    },
    { label: "decision with priority 1", kind: "decision" as const, priority: 1, expected: [] },
    {
      label: "decision with priority 4",
      kind: "decision" as const,
      priority: 4,
      expected: ["Priority 4 cannot rank this item. Set priority to the number 1, 2 or 3."],
    },
    {
      label: "work without priority",
      kind: "work" as const,
      priority: undefined,
      expected: ["Priority undefined cannot rank this item. Set priority to the number 1, 2 or 3."],
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
        "Item id Bad cannot be used as a valid item reference. Rename the Markdown file using lowercase ASCII letters, digits or hyphens and start the id with a letter or digit.",
        "Kind task is unsupported. Set kind to decision, review, work or goal.",
        "Status done is unsupported. Set status to open, assumed or decided.",
        "Priority 5 cannot rank this item. Set priority to the number 1, 2 or 3.",
        "Order soon cannot sort the item. Use a number for order or omit it.",
        "No one is assigned to move this item. Set owner in the frontmatter.",
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
      [
        "area needs text for display. Use a string or number.",
        "quote needs text for display. Use a string or number.",
      ],
    ],
  ])("checks %s", (_label, fields, expected) => {
    expect(textFieldDefects(fields as unknown as Item)).toEqual(expected);
  });
});

describe("dueDefects", () => {
  test.each([
    ["absent due date", undefined, []],
    ["valid leap day", "2028-02-29", []],
    [
      "impossible calendar day",
      "2026-02-30",
      ["Due date 2026-02-30 is unusable for sorting. Set due to a valid YYYY-MM-DD date."],
    ],
    [
      "non-ISO date string",
      "3 Nov",
      ["Due date 3 Nov is unusable for sorting. Set due to a valid YYYY-MM-DD date."],
    ],
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
  const sparse: unknown[] = new Array(2);
  sparse[1] = "a";
  test.each([
    ["absent needs", undefined, { value: undefined, defects: [] }],
    [
      "scalar instead of list",
      "check",
      { value: undefined, defects: ["needs must be a list. Use a list of item ids"] },
    ],
    ["sparse list skipping holes", sparse, { value: ["a"], defects: [] }],
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
      expected: [
        "A work item has status assumed. Set status to open, the only state for work and goals.",
      ],
    },
    {
      label: "decided goal",
      kind: "goal" as const,
      status: "decided" as const,
      expected: [
        "A goal item has status decided. Set status to open, the only state for work and goals.",
      ],
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
      expected: [
        "An open decision needs at least two options for a choice. Add entries under options or set kind to review for a review request.",
      ],
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
    {
      label: "null entry",
      option: null,
      index: 0,
      expected:
        "Option 1 needs a key for references and a label to display. Fill in both fields on that options entry.",
    },
    {
      label: "empty label",
      option: { key: "a", label: "" },
      index: 1,
      expected:
        "Option 2 needs a key for references and a label to display. Fill in both fields on that options entry.",
    },
    {
      label: "key with comma",
      option: { key: "a,b", label: "AB" },
      index: 0,
      expected:
        'Option 1 has an invalid reference key "a,b". Set its key to a string or number without whitespace or commas.',
    },
    {
      label: "non-text detail",
      option: { key: "a", label: "Alpha", detail: ["list"] },
      index: 0,
      expected:
        "The hub needs text to display the label and detail for option a. Set label and any detail to strings or numbers.",
    },
  ])("checks $label", ({ option, index, expected }) => {
    expect(optionEntryDefect(option, index)).toBe(expected);
  });
});

describe("parseOptions", () => {
  test.each([
    ["undefined options", undefined, { value: undefined, keys: [], defects: [] }],
    [
      "non-list options",
      "a",
      {
        value: undefined,
        keys: [],
        defects: ["Choices need a list. Write options as YAML list entries with key and label."],
      },
    ],
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
          "Option 1 needs a key for references and a label to display. Fill in both fields on that options entry.",
          "The hub needs text to display the label and detail for option 0. Set label and any detail to strings or numbers.",
          "Duplicate option keys make references ambiguous. Give each options entry a unique key and update any recommended or images references to the renamed key.",
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
      expected: [
        "Multiple value yes does not specify whether several choices are allowed. Set multiple to true or false in the frontmatter.",
      ],
    },
    {
      label: "several recommended without multiple and unknown option",
      recommended: ["a", "z"],
      multiple: false,
      keys: ["a", "b"],
      expected: [
        "Multiple picks need opt-in. Set multiple to true or keep one recommendation.",
        "Recommended key z has no choice. Use an option key in recommended.",
      ],
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
        "Option a has a score of 8, which cannot be used as a numeric review score. Set score to a number.",
        "Noise requires a score for option b. Set both to numbers or omit noise.",
        "Noise requires a score for option c. Set both to numbers or omit noise.",
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
    [
      "assumed with neither",
      { status: "assumed" },
      ["The hub shows what was assumed. Fill in assumption or recommended."],
    ],
    ["decided with decision and by", { status: "decided", decision: "Use A", by: "Alex" }, []],
    [
      "decided without by",
      { status: "decided", decision: "Use A" },
      ["Record what was decided and who decided it. Fill in decision and by."],
    ],
    [
      "decided without decision",
      { status: "decided", by: "Alex" },
      ["Record what was decided and who decided it. Fill in decision and by."],
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
    [
      "missing bare file",
      "missing.png",
      "The hub cannot display image docs/agent-work/items/pick/missing.png. Add the missing file or fix its path in images.",
    ],
    [
      "unexpected extra key",
      { src: "a.png", alt: "x" },
      'The hub cannot read the image entry {"src":"a.png","alt":"x"}. Use a path string or an object with a string src and an optional string caption.',
    ],
    [
      "null entry",
      null,
      "The hub cannot read the image entry null. Use a path string or an object with a string src and an optional string caption.",
    ],
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
      expected: ["The hub groups images by item or option. Use a list or mapping in images."],
    },
    { label: "valid list", images: ["a.png"], keys: [], expected: [] },
    {
      label: "mapping with unknown option key and missing image",
      images: { a: "a.png", ghost: "missing.png" },
      keys: ["a"],
      expected: [
        "Image key ghost has no matching choice. Use a key from options in the images mapping or use an images list for the item as a whole.",
        "The hub cannot display image docs/agent-work/items/pick/missing.png. Add the missing file or fix its path in images.",
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
