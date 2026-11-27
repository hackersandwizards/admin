import { describe, expect, test } from "vitest";
import { ItemError, type Item } from "../src/items.ts";
import {
  classifyItemPath,
  legacyPathDefects,
  loadItemFile,
  needsGraphDefects,
  readItems,
} from "../src/item-source.ts";

describe("classifyItemPath", () => {
  test.each([
    ["path outside items dir", "docs/agent-work/2026-01-15-report.md", { kind: "outside" }],
    ["adjacent prefix folder", "docs/agent-work/items-old/a.md", { kind: "outside" }],
    ["item markdown file", "docs/agent-work/items/pick-a.md", { kind: "item", id: "pick-a" }],
    [
      "one-level image with uppercase extension",
      "docs/agent-work/items/pick-a/shot.PNG",
      { kind: "image", ownerId: "pick-a" },
    ],
    ["deeper nested image", "docs/agent-work/items/pick-a/sub/shot.png", { kind: "stray" }],
    ["non-markdown direct file", "docs/agent-work/items/notes.txt", { kind: "stray" }],
    ["non-image file in item folder", "docs/agent-work/items/pick-a/notes.txt", { kind: "stray" }],
  ])("classifies %s", (_label, path, expected) => {
    expect(classifyItemPath(path)).toEqual(expected);
  });
});

describe("loadItemFile", () => {
  const emptyFields = {
    area: undefined,
    assumption: undefined,
    by: undefined,
    decision: undefined,
    due: undefined,
    evidence: undefined,
    images: undefined,
    needs: undefined,
    options: undefined,
    order: undefined,
    owner: undefined,
    priority: undefined,
    quote: undefined,
    recommended: undefined,
    topic: undefined,
  };

  test.each([
    {
      label: "valid goal file",
      id: "goal",
      read: () => "---\nkind: goal\nstatus: open\n---\n# Goal",
      expected: {
        item: { ...emptyFields, id: "goal", kind: "goal", status: "open", title: "Goal", body: "" },
        defects: [],
      },
    },
    {
      label: "blank YAML recommendation",
      id: "unpicked",
      read: () => "---\nkind: goal\nstatus: open\nrecommended:\n---\n# Unpicked",
      expected: {
        item: {
          ...emptyFields,
          id: "unpicked",
          kind: "goal",
          status: "open",
          title: "Unpicked",
          body: "",
        },
        defects: [],
      },
    },
    {
      label: "malformed field returning normalized item and defect",
      id: "odd",
      read: () => "---\nkind: goal\nstatus: open\norder: soon\n---\n# Odd",
      expected: {
        item: { ...emptyFields, id: "odd", kind: "goal", status: "open", title: "Odd", body: "" },
        defects: ["Order soon cannot sort the item. Use a number for order or omit it."],
      },
    },
    {
      label: "file with parse error",
      id: "bad",
      read: () => "No frontmatter",
      expected: {
        defects: [
          "The check cannot read item fields without YAML frontmatter. Put the fields between two --- lines at the top of the item file.",
        ],
      },
    },
    {
      label: "unreadable file returning undefined",
      id: "missing",
      read: () => undefined,
      expected: {
        defects: [
          "The check cannot read item fields without YAML frontmatter. Put the fields between two --- lines at the top of the item file.",
        ],
      },
    },
    {
      label: "reader throwing ItemError",
      id: "broken",
      read: () => {
        throw new ItemError("invalid encoding");
      },
      expected: { defects: ["invalid encoding"] },
    },
  ])("loads $label", ({ id, read, expected }) => {
    expect(loadItemFile(id, read, () => true)).toEqual(expected);
  });

  test("rethrows non-ItemError failures from the reader", () => {
    expect(() =>
      loadItemFile(
        "boom",
        () => {
          throw new Error("disk full");
        },
        () => true,
      ),
    ).toThrow("disk full");
  });

  test("validates an item before normalizing it", () => {
    const text =
      "---\nkind: goal\nstatus: open\ntopic: 2026-01-15-sample\nrecommended:\n  toString: 1\n---\n# Goal";
    expect(() =>
      loadItemFile(
        "order-check",
        () => text,
        () => {
          throw new Error("defects-first");
        },
      ),
    ).toThrow("defects-first");
  });
});

describe("legacyPathDefects", () => {
  test.each([
    ["clean paths", ["README.md", "docs/agent-work/items/goal.md"], []],
    [
      "GOAL.md and docs/tracking files in order",
      ["docs/tracking/a.md", "GOAL.md", "docs/tracking/b.md"],
      [
        "GOAL.md: The hub reads goals as items. Move the goal to docs/agent-work/items/goal.md with kind: goal and status: open, then remove the legacy file.",
        "docs/tracking/a.md: This file sits outside the agent-work layout. Move it to the matching path under docs/agent-work.",
        "docs/tracking/b.md: This file sits outside the agent-work layout. Move it to the matching path under docs/agent-work.",
      ],
    ],
  ])("reports defects for %s", (_label, paths, expected) => {
    expect(legacyPathDefects(paths)).toEqual(expected);
  });
});

describe("needsGraphDefects", () => {
  const goal = (id: string, needs?: string[]): Item => ({
    id,
    kind: "goal",
    status: "open",
    needs,
    title: id,
    body: "",
  });

  test.each([
    ["acyclic graph", [goal("a", ["b"]), goal("b")], []],
    [
      "unknown prerequisite reported once despite duplicates",
      [goal("a", ["missing", "missing"])],
      [
        'docs/agent-work/items/a.md: needs unknown item "missing". Use an id for an item in this repository, or remove this entry once the needed item is done',
      ],
    ],
    [
      "self prerequisite",
      [goal("a", ["a"])],
      ['docs/agent-work/items/a.md: needs itself. Remove "a"'],
    ],
    [
      "three-node cycle",
      [goal("a", ["b"]), goal("b", ["c"]), goal("c", ["a"])],
      [
        "docs/agent-work/items/c.md: needs closes a cycle (a → b → c → a). Remove a prerequisite in this cycle",
      ],
    ],
  ])("checks %s", (_label, items, expected) => {
    expect(needsGraphDefects(items)).toEqual(expected);
  });
});

describe("readItems defect ordering", () => {
  test("reports a malformed recommendation and continues checking prerequisites", () => {
    const files: Record<string, string> = {
      "docs/agent-work/items/alpha.md":
        "---\nkind: goal\nstatus: open\nrecommended: {toString: sample}\n---\n# Alpha",
      "docs/agent-work/items/beta.md":
        "---\nkind: goal\nstatus: open\nneeds: [missing]\n---\n# Beta",
    };

    const { defects } = readItems({ paths: Object.keys(files), read: (path) => files[path] });

    expect(defects).toEqual([
      "docs/agent-work/items/alpha.md: recommended entry 1 must be a string or number. Use an option key",
      'docs/agent-work/items/beta.md: needs unknown item "missing". Use an id for an item in this repository, or remove this entry once the needed item is done',
    ]);
  });

  test("reports path, item, legacy, tracking, and needs-graph defects in order", () => {
    const files: Record<string, string> = {
      "docs/agent-work/items/gone/shot.png": "",
      "docs/agent-work/items/notes.txt": "stray",
      "docs/agent-work/items/alpha.md":
        "---\nkind: goal\nstatus: open\norder: late\nneeds: [beta]\n---\n# Alpha",
      "docs/agent-work/items/beta.md":
        "---\nkind: goal\nstatus: open\nneeds: [alpha, missing]\n---\n# Beta",
      "docs/agent-work/items/self.md": "---\nkind: goal\nstatus: open\nneeds: [self]\n---\n# Self",
      "GOAL.md": "# Legacy goal",
      "docs/tracking/old.md": "# Old tracking",
    };

    const { items, defects } = readItems({
      paths: Object.keys(files),
      read: (path) => files[path],
    });

    expect(items.map((item) => item.id)).toEqual(["alpha", "beta", "self"]);
    expect(defects).toEqual([
      "docs/agent-work/items/gone/shot.png: The hub has no item gone.md to attach this image to. Add that item beside the image folder or move the image out of the items directory.",
      "docs/agent-work/items/notes.txt: The hub skips this path when reading items in docs/agent-work/items. Move the file out of the items directory or place it at <id>.md for an item or <id>/<image> for an item image.",
      "docs/agent-work/items/alpha.md: Order late cannot sort the item. Use a number for order or omit it.",
      "GOAL.md: The hub reads goals as items. Move the goal to docs/agent-work/items/goal.md with kind: goal and status: open, then remove the legacy file.",
      "docs/tracking/old.md: This file sits outside the agent-work layout. Move it to the matching path under docs/agent-work.",
      "docs/agent-work/items/beta.md: needs closes a cycle (alpha → beta → alpha). Remove a prerequisite in this cycle",
      'docs/agent-work/items/beta.md: needs unknown item "missing". Use an id for an item in this repository, or remove this entry once the needed item is done',
      'docs/agent-work/items/self.md: needs itself. Remove "self"',
    ]);
  });
});
