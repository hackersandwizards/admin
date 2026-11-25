import { describe, expect, test } from "vitest";
import type { Item } from "../src/items.ts";
import { needsGraphItems, openPrerequisites, prerequisiteSummary } from "../src/needs-graph.ts";
import type { ViewItem } from "../src/site-data.ts";

const makeItem = (overrides: Partial<Item> & { id: string }): Item => ({
  kind: "work",
  status: "open",
  priority: 2,
  owner: "Kira",
  title: overrides.id,
  body: "",
  ...overrides,
});

const makeViewItem = (overrides: Partial<ViewItem> & { id: string }): ViewItem => ({
  ...makeItem(overrides),
  repo: "demo",
  repoLabel: "Demo",
  who: "Kira",
  agent: false,
  html: "",
  optionImages: {},
  recommendedKeys: [],
  waitingOn: [],
  waitingCount: 0,
  ...overrides,
});

describe("openPrerequisites", () => {
  const byId = new Map<string, Item>(
    [
      makeItem({ id: "open-a", status: "open" }),
      makeItem({ id: "open-z", status: "open" }),
      makeItem({ id: "settled", status: "decided", needs: ["open-a"] }),
      makeItem({ id: "cyc-a", status: "open", needs: ["cyc-b"] }),
      makeItem({ id: "cyc-b", status: "open", needs: ["cyc-a", "open-a"] }),
      makeItem({ id: "dia-left", status: "open", needs: ["open-a"] }),
      makeItem({ id: "dia-right", status: "open", needs: ["open-a"] }),
    ].map((i) => [i.id, i]),
  );

  test.each([
    {
      label: "returns empty list when item has no needs",
      item: makeItem({ id: "lone" }),
      expected: [],
    },
    {
      label: "returns only open direct prerequisites sorted alphabetically",
      item: makeItem({ id: "direct", needs: ["open-z", "open-a"] }),
      expected: ["open-a", "open-z"],
    },
    {
      label: "walks through settled items to find transitive open prerequisites",
      item: makeItem({ id: "trans", needs: ["settled"] }),
      expected: ["open-a"],
    },
    {
      label: "terminates on cycles without including the starting item",
      item: makeItem({ id: "cyc-a", needs: ["cyc-b"] }),
      expected: ["cyc-b", "open-a"],
    },
    {
      label: "deduplicates diamond prerequisites",
      item: makeItem({ id: "dia", needs: ["dia-left", "dia-right"] }),
      expected: ["dia-left", "dia-right", "open-a"],
    },
    {
      label: "skips unknown prerequisite ids",
      item: makeItem({ id: "ghost", needs: ["missing", "open-z"] }),
      expected: ["open-z"],
    },
  ])("$label", ({ item, expected }) => {
    expect(openPrerequisites(item, byId)).toEqual(expected);
  });
});

describe("prerequisiteSummary", () => {
  test("records waitingOn for every item with needs and counts only open waiters", () => {
    const { waitingOn, waitingCount } = prerequisiteSummary([
      makeItem({ id: "base", status: "open" }),
      makeItem({ id: "mid", status: "decided", needs: ["base"] }),
      makeItem({ id: "top", status: "open", needs: ["mid"] }),
      makeItem({ id: "done-waiter", status: "assumed", needs: ["base"] }),
      makeItem({ id: "solo", status: "open" }),
    ]);
    expect(Object.fromEntries(waitingOn)).toEqual({
      mid: ["base"],
      top: ["base"],
      "done-waiter": ["base"],
    });
    expect(Object.fromEntries(waitingCount)).toEqual({ base: 1 });
  });
});

describe("needsGraphItems", () => {
  test("preserves input order while dropping isolated items and self-needs", () => {
    const connected = needsGraphItems([
      makeViewItem({ id: "iso" }),
      makeViewItem({ id: "second", needs: ["first"] }),
      makeViewItem({ id: "self", needs: ["self"] }),
      makeViewItem({ id: "first" }),
    ]);
    expect(connected.map((i) => i.id)).toEqual(["second", "first"]);
  });
});
