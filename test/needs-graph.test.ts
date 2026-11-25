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
      label: "returns open direct prerequisites in walk order",
      item: makeItem({ id: "direct", needs: ["open-a", "open-z"] }),
      expected: ["open-z", "open-a"],
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
      expected: ["dia-right", "open-a", "dia-left"],
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
  test("sorts waitingOn and builds waitingCount keys in walk order for open waiters only", () => {
    const { waitingOn, waitingCount } = prerequisiteSummary([
      makeItem({ id: "open-a", status: "open" }),
      makeItem({ id: "open-z", status: "open" }),
      makeItem({ id: "mid", status: "decided", needs: ["open-a"] }),
      makeItem({ id: "top", status: "open", needs: ["mid", "open-z"] }),
      makeItem({ id: "done-waiter", status: "assumed", needs: ["open-a"] }),
      makeItem({ id: "solo", status: "open" }),
    ]);
    expect(Object.fromEntries(waitingOn)).toEqual({
      mid: ["open-a"],
      top: ["open-a", "open-z"],
      "done-waiter": ["open-a"],
    });
    expect([...waitingCount.entries()]).toEqual([
      ["open-z", 1],
      ["open-a", 1],
    ]);
  });
});

describe("needsGraphItems", () => {
  test("preserves input order even when connected set insertion order differs", () => {
    const connected = needsGraphItems([
      makeViewItem({ id: "iso" }),
      makeViewItem({ id: "first" }),
      makeViewItem({ id: "self", needs: ["self"] }),
      makeViewItem({ id: "second", needs: ["first"] }),
    ]);
    expect(connected.map((i) => i.id)).toEqual(["first", "second"]);
  });
});
