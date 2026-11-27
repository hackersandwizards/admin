import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Window, type Element as DomEl, type Node as DomNode } from "happy-dom";
import { afterAll, assert, beforeAll, describe, expect, test, vi } from "vitest";
import { defined } from "@hackersandwizards/scaffolding/defined";
import { tableScroll as brandTableScroll } from "@hackersandwizards/brand/elements/table.ts";
import { needsGraph, needsGraphItems } from "../src/needs-graph.ts";
import { siteData } from "../src/site-data.ts";
import * as diagrams from "../src/diagrams.ts";
import {
  compareItems,
  DUE_SOON_DAYS,
  dueSoon,
  imagesOf,
  ItemError,
  parseItem,
  type Item,
} from "../src/items.ts";
import { itemDefects, usable } from "../src/item-validation.ts";
import { thumbnail, when } from "../src/display.ts";
import { gitEnv, treeSource } from "../src/git.ts";
import { readItems } from "../src/item-source.ts";
import { renderDocMarkdown, renderItemMarkdown } from "../src/markdown.ts";
import { readRepo } from "../src/repo.ts";
import { dueOf, inline, prerequisiteLabels, withLinks } from "../site/src/data.ts";
import { commit, fromFiles, inZone, repoFrom, sh } from "./admin-fixtures.ts";

const FIX = join(import.meta.dirname, "fixtures");

const valid: Item = {
  id: "a-question",
  kind: "decision",
  status: "open",
  priority: 2,
  owner: "Alex",
  options: [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ],
  recommended: "a",
  title: "A question?",
  body: "Context.",
};
const exists = () => true;

test("prerequisite labels list open ids and pluralize the count", () => {
  expect(prerequisiteLabels({ waitingOn: [], waitingCount: 0 })).toEqual([]);
  expect(prerequisiteLabels({ waitingOn: ["check"], waitingCount: 0 })).toEqual([
    "Waiting on check",
  ]);
  expect(prerequisiteLabels({ waitingOn: [], waitingCount: 1 })).toEqual([
    "1 open item waits on this",
  ]);
  expect(prerequisiteLabels({ waitingOn: ["check", "draft"], waitingCount: 2 })).toEqual([
    "Waiting on check, draft",
    "2 open items wait on this",
  ]);
});

describe("needs graph", () => {
  const fixture = async () => {
    const dir = join(FIX, "spoke");
    return defined(
      siteData([await readRepo(dir, treeSource(dir))]).repos[0],
      "first rendered repository",
    );
  };
  const graphDocument = (html: string | undefined) => {
    const doc = new Window().document;
    doc.body.innerHTML = defined(html, "needs graph SVG").replace(/<style>[\s\S]*?<\/style>/g, "");
    return doc;
  };

  describe("spoke fixture graph", () => {
    let graph: ReturnType<typeof graphDocument>;
    let connected: ReturnType<typeof needsGraphItems>;
    const itemByNode = new Map<string, string>();
    const nodeByItem = new Map<string, DomEl>();

    beforeAll(async () => {
      const { items, needsSvg } = await fixture();
      graph = graphDocument(needsSvg);
      connected = needsGraphItems(items);
      const idByTitle = new Map(connected.map((item) => [item.title, item.id]));
      for (const node of graph.querySelectorAll(".node")) {
        const itemId = defined(
          idByTitle.get(defined(node.getAttribute("data-label"), "attribute data-label")),
          "item ID for graph node label",
        );
        itemByNode.set(defined(node.getAttribute("data-id"), "attribute data-id"), itemId);
        nodeByItem.set(itemId, node);
      }
    });

    test("numbers graph nodes n0..n5 in the order of needsGraphItems", () => {
      expect(
        [...graph.querySelectorAll(".node")].map((node) => [
          node.getAttribute("data-id"),
          node.getAttribute("data-label"),
        ]),
      ).toEqual(connected.map((item, index) => [`n${index}`, item.title]));
    });

    test("assigns stadium, rectangle, and rounded shapes to ready, waiting, and settled items", () => {
      expect(
        [...nodeByItem.entries()]
          .map(([id, node]) => [id, node.getAttribute("data-shape")] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
      ).toEqual([
        ["cache-folder", "rounded"],
        ["check-the-copy", "rectangle"],
        ["goal", "stadium"],
        ["name-the-command", "rounded"],
        ["pick-a-variant", "stadium"],
        ["work-wire-the-gate", "rectangle"],
      ]);
    });

    test("draws every needs edge with solid open and dotted settled styles", () => {
      expect(
        [...graph.querySelectorAll(".edge")]
          .map((edge) => ({
            from: itemByNode.get(defined(edge.getAttribute("data-from"), "attribute data-from")),
            to: itemByNode.get(defined(edge.getAttribute("data-to"), "attribute data-to")),
            style: edge.getAttribute("data-style"),
            dashed: edge.hasAttribute("stroke-dasharray"),
          }))
          .toSorted((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`)),
      ).toEqual([
        { from: "cache-folder", to: "work-wire-the-gate", style: "dotted", dashed: true },
        { from: "check-the-copy", to: "work-wire-the-gate", style: "solid", dashed: false },
        { from: "goal", to: "name-the-command", style: "solid", dashed: false },
        { from: "name-the-command", to: "work-wire-the-gate", style: "dotted", dashed: true },
        { from: "pick-a-variant", to: "cache-folder", style: "solid", dashed: false },
        { from: "pick-a-variant", to: "check-the-copy", style: "solid", dashed: false },
      ]);
    });

    test.each(["goal", "pick-a-variant"])(
      "draws ready stadium %s with corner radius equal to half its height",
      (id) => {
        const rect = defined(
          defined(nodeByItem.get(id), `graph node for ${id}`).querySelector("rect"),
          "element matching rect",
        );
        const radius = Number(rect.getAttribute("rx"));
        const halfHeight = Number(rect.getAttribute("height")) / 2;
        expect(halfHeight).toBeGreaterThan(0);
        expect(radius).toBe(halfHeight);
      },
    );

    test.each(["check-the-copy", "work-wire-the-gate"])(
      "draws waiting rectangle %s with corner radius 0",
      (id) => {
        const rect = defined(
          defined(nodeByItem.get(id), `graph node for ${id}`).querySelector("rect"),
          "element matching rect",
        );
        expect(Number(rect.getAttribute("rx"))).toBe(0);
      },
    );

    test.each(["cache-folder", "name-the-command"])(
      "draws settled rounded node %s with corner radius strictly between 0 and half its height",
      (id) => {
        const rect = defined(
          defined(nodeByItem.get(id), `graph node for ${id}`).querySelector("rect"),
          "element matching rect",
        );
        const radius = Number(rect.getAttribute("rx"));
        const halfHeight = Number(rect.getAttribute("height")) / 2;
        expect(radius).toBeGreaterThan(0);
        expect(radius).toBeLessThan(halfHeight);
      },
    );
  });

  test("the prerequisite stands on the left in the Mermaid source and the SVG", async () => {
    const { items } = await fixture();
    const wire = defined(
      items.find((item) => item.id === "work-wire-the-gate"),
      "item work-wire-the-gate",
    );
    const check = defined(
      items.find((item) => item.id === "check-the-copy"),
      "item check-the-copy",
    );
    const render = vi.spyOn(diagrams, "diagram");
    try {
      const graph = graphDocument(needsGraph([wire, check]));
      expect(graph.querySelectorAll(".edge")).toHaveLength(1);
      const x = (id: string) =>
        Number(
          defined(
            graph.querySelector(`[data-id="${id}"] rect`),
            `element matching [data-id="${id}"] rect`,
          ).getAttribute("x"),
        );
      expect(x("n1")).toBeLessThan(x("n0"));
      expect(render.mock.calls[0]?.[0].split("\n").slice(-1)).toEqual(["n1 --> n0"]);
    } finally {
      render.mockRestore();
    }
  });

  test("quoted graph titles show literal punctuation and item ids never become Mermaid syntax", async () => {
    const { items } = await fixture();
    const title =
      'Try " ] ) | < > & # ; ` %% ]) <br> **plain** ~~plain~~ \\n &#93;\u2028A\u2029B\rC\nn7 --> n8\nD';
    const input = [
      {
        ...defined(items[0], "first graph item"),
        id: "try--this",
        title,
        status: "open" as const,
        waitingOn: [],
        needs: [],
      },
      {
        ...defined(items[1], "second graph item"),
        title,
        status: "open" as const,
        waitingOn: ["try--this"],
        needs: ["try--this"],
      },
      { ...defined(items[2], "third graph item"), title, status: "decided" as const, needs: [] },
    ];
    const graph = graphDocument(needsGraph(input));
    expect(
      [...graph.querySelectorAll(".node")].map((node) => ({
        shape: node.getAttribute("data-shape"),
        label: node.getAttribute("data-label"),
        texts: [...node.querySelectorAll("text")].map((el) => el.textContent),
      })),
    ).toEqual([
      { shape: "stadium", label: title, texts: [title] },
      { shape: "rectangle", label: title, texts: [title] },
      { shape: "rounded", label: title, texts: [title] },
    ]);
    expect(
      [...graph.querySelectorAll(".edge")].map((edge) => [
        edge.getAttribute("data-from"),
        edge.getAttribute("data-to"),
      ]),
    ).toEqual([["n0", "n1"]]);
  });

  test("site data omits the graph when a need names only an unknown item", async () => {
    const repo = await fromFiles({
      "docs/agent-work/items/goal.md":
        "---\nkind: goal\nstatus: open\nneeds: [absent]\n---\n# Goal",
    });
    expect(repo.defects.join("\n")).toContain('needs unknown item "absent"');
    expect(siteData([repo]).repos[0]).not.toHaveProperty("needsSvg");
  });

  test("an open item with only settled prerequisites is a stadium", async () => {
    const repo = await fromFiles({
      "docs/agent-work/items/draft.md":
        "---\nkind: work\nstatus: open\npriority: 2\nowner: an agent\nneeds: [check]\n---\n# Draft",
      "docs/agent-work/items/check.md":
        "---\nkind: review\nstatus: assumed\npriority: 2\nowner: an agent\nassumption: Proceed\n---\n# Check",
    });
    const graph = graphDocument(
      defined(siteData([repo]).repos[0], "first rendered repository").needsSvg,
    );
    expect(graph.querySelector('[data-label="Draft"]')?.getAttribute("data-shape")).toBe("stadium");
  });

  test("the graph drops self-needs and draws duplicate prerequisites once", async () => {
    const repo = await fromFiles({
      "docs/agent-work/items/first.md":
        "---\nkind: goal\nstatus: open\nneeds: [first]\n---\n# First",
      "docs/agent-work/items/second.md":
        "---\nkind: work\nstatus: open\npriority: 2\nowner: an agent\nneeds: [first, first]\n---\n# Second",
      "docs/agent-work/items/isolated.md":
        "---\nkind: work\nstatus: open\npriority: 2\nowner: an agent\nneeds: [isolated]\n---\n# Isolated",
    });
    const graph = graphDocument(
      defined(siteData([repo]).repos[0], "first rendered repository").needsSvg,
    );
    expect(graph.querySelectorAll(".node")).toHaveLength(2);
    const edges = [...graph.querySelectorAll(".edge")];
    expect(edges).toHaveLength(1);
    const label = (id: string | null) =>
      graph.querySelector(`[data-id="${id}"]`)?.getAttribute("data-label");
    expect(
      edges.map((edge) => [
        label(edge.getAttribute("data-from")),
        label(edge.getAttribute("data-to")),
      ]),
    ).toEqual([["First", "Second"]]);
  });

  test("site data omits the graph without drawable needs edges or a rendered SVG", async () => {
    const lone = await fromFiles({
      "docs/agent-work/items/goal.md": "---\nkind: goal\nstatus: open\n---\n# Goal",
    });
    expect(siteData([lone]).repos[0]).not.toHaveProperty("needsSvg");
    const render = vi
      .spyOn(diagrams, "diagram")
      .mockReturnValue('<pre><code class="language-mermaid">flowchart LR</code></pre>');
    try {
      expect(await fixture()).not.toHaveProperty("needsSvg");
      expect(render).toHaveBeenCalledTimes(4);
    } finally {
      render.mockRestore();
    }
  });
});

describe("item files", () => {
  test.each([
    [
      "missing",
      ["ship: [missing]"],
      'ship.md: needs unknown item "missing". Use an id for an item in this repository',
    ],
    [
      "duplicated",
      ["ship: [check, check]", "check: []"],
      'ship.md: needs has duplicate item "check". Remove entry 2',
    ],
    ["itself", ["ship: [ship]"], "ship.md: needs itself"],
    [
      "cycle",
      ["ship: [check]", "check: [draft]", "draft: [ship]"],
      "draft.md: needs closes a cycle",
    ],
    ["non-string", ["ship: [true]"], "ship.md: needs entry 1 must be a string"],
    ["non-list", ["ship: check"], "ship.md: needs must be a list"],
  ])("admin-check reports a prerequisite that is %s", (_case, entries, problem) => {
    const files = new Map(
      entries.map((entry) => {
        const [id, needs] = entry.split(": ");
        return [
          `docs/agent-work/items/${id}.md`,
          `---\nkind: goal\nstatus: open\nneeds: ${needs}\n---\n# ${id}`,
        ];
      }),
    );
    const { defects } = readItems({ paths: [...files.keys()], read: (p) => files.get(p) });
    expect(defects).toHaveLength(1);
    expect(defects[0]).toContain(problem);
    expect(defects[0]).toMatch(/\. (Use|Remove) /);
  });

  test("a malformed rank does not displace a ranked item", () => {
    const odd = usable(
      parseItem("odd", "---\nkind: decision\nstatus: open\npriority: 2\norder: soon\n---\n# Odd"),
    );
    const ranked = { ...valid, id: "ranked", order: 10 };
    expect([odd, ranked].sort(compareItems).map((item) => item.id)).toEqual(["ranked", "odd"]);
  });

  test("a due date in year 9999 still ranks ahead of an undated item", () => {
    expect(compareItems({ ...valid, due: "9999-01-02" }, valid)).toBeLessThan(0);
  });

  test("a due date comes within a week by local day, also just after midnight", () => {
    // East of UTC, half past midnight is still the day before in UTC.
    inZone("Europe/Berlin", () => {
      const night = new Date();
      night.setHours(0, 30, 0, 0);
      const local = (n: number) => {
        const d = new Date(night);
        d.setDate(d.getDate() + n);
        return d.toLocaleDateString("sv-SE");
      };
      expect(dueSoon(local(DUE_SOON_DAYS), night.getTime())).toBe(true);
      expect(dueSoon(local(DUE_SOON_DAYS + 1), night.getTime())).toBe(false);
    });
  });

  test("a Unicode line separator inside a heading stays in the title", () => {
    const item = parseItem(
      "title",
      '---\nkind: work\nstatus: open\npriority: 2\nowner: ""\n---\n\n# Draft \u2028!\n\n\n',
    );
    expect(item.title).toBe("Draft \u2028!");
    expect(item.body).toBe("");
  });

  test.each(["Context without a heading", "#  \t\n\nContext after a blank heading"])(
    "an item needs a title (%#)",
    (body) => {
      expect(() => parseItem("untitled", `---\nkind: goal\nstatus: open\n---\n${body}`)).toThrow(
        new ItemError(
          'The hub gets the item title from the first heading. Start the body after frontmatter with "# " followed by a nonempty title.',
        ),
      );
    },
  );

  test("a valid item has no defects", () => {
    expect(itemDefects(valid, exists)).toEqual([]);
  });

  test.each([
    [{ priority: 4 }, "Priority 4 cannot rank this item. Set priority to the number 1, 2 or 3."],
    [{ priority: undefined }, "No priority is set. Set priority to the number 1, 2 or 3."],
    [{ kind: "task" }, "Kind task is unsupported. Set kind to decision, review, work or goal."],
    [{ status: "done" }, "Status done is unsupported. Set status to open, assumed or decided."],
    [{ owner: undefined }, "No one is assigned to move this item. Set owner in the frontmatter."],
    [
      { options: [{ key: "a", label: "A" }] },
      "An open decision needs at least two options for a choice. Add entries under options or set kind to review for a review request.",
    ],
    [{ status: "decided" }, "Record what was decided and who decided it. Fill in decision and by."],
    [
      { status: "assumed", recommended: undefined },
      "The hub shows what was assumed. Fill in assumption or recommended.",
    ],
    [
      { due: "3 Nov" },
      "Due date 3 Nov is unusable for sorting. Set due to a valid YYYY-MM-DD date.",
    ],
    [
      { id: "Bad_Id" },
      "Item id Bad_Id cannot be used as a valid item reference. Rename the Markdown file using lowercase ASCII letters, digits or hyphens and start the id with a letter or digit.",
    ],
    [
      { kind: "work", status: "assumed" },
      "A work item has status assumed. Set status to open, the only state for work and goals.",
    ],
    [
      { kind: "goal", priority: 2 },
      "Goals must use the default priority. Remove priority from the frontmatter.",
    ],
    [
      { recommended: ["a", "b"] },
      "Multiple picks need opt-in. Set multiple to true or keep one recommendation.",
    ],
    [
      { multiple: "yes" },
      "Multiple value yes does not specify whether several choices are allowed. Set multiple to true or false in the frontmatter.",
    ],
    [
      {
        options: [
          { key: "a", label: "A", score: "8" },
          { key: "b", label: "B" },
        ],
      },
      'Option a has a score of "8", which cannot be used as a numeric review score. Set score to a number.',
    ],
    [
      {
        options: [
          { key: "a", label: "A", noise: 1 },
          { key: "b", label: "B" },
        ],
      },
      "Noise requires a score for option a. Set both to numbers or omit noise.",
    ],
    [
      { images: [{ src: "x.jpg", alt: "x" }] },
      'The hub cannot read the image entry {"src":"x.jpg","alt":"x"}. Use a path string or an object with a string src and an optional string caption.',
    ],
    [
      { images: { a: [{ caption: "no src" }] } },
      'The hub cannot read the image entry {"caption":"no src"}. Use a path string or an object with a string src and an optional string caption.',
    ],
  ] as [Partial<Item>, string][])("defect %#: %o", (change, message) => {
    const defects = itemDefects({ ...valid, ...change } as Item, exists);
    expect(defects.join("\n")).toContain(message);
  });

  test("a missing image is a defect; a bare name lies in the item's own folder", () => {
    const item = { ...valid, images: { a: "docs/x.jpg", b: [{ src: "y.jpg", caption: "dark" }] } };
    expect(itemDefects(item, () => false)).toEqual([
      "The hub cannot display image docs/x.jpg. Add the missing file or fix its path in images.",
      "The hub cannot display image docs/agent-work/items/a-question/y.jpg. Add the missing file or fix its path in images.",
    ]);
  });

  test("an item without page: the field is gone", () => {
    expect(() =>
      parseItem("x", "---\nkind: review\npage: docs/p/index.html\n---\n\n# T\n"),
    ).toThrow(
      "Unrecognized item fields: page. Remove them or use a supported field from node_modules/@hackersandwizards/admin/docs/items.md.",
    );
  });

  test.each([
    {
      label: "out-of-range ISO month and day",
      change: { due: "2026-13-45" },
      expected: [
        "Due date 2026-13-45 is unusable for sorting. Set due to a valid YYYY-MM-DD date.",
      ],
    },
    {
      label: "leap-day ISO due date",
      change: { due: "2028-02-29" },
      expected: [],
    },
    {
      label: "object-valued area on an otherwise valid item",
      change: { area: { a: 1 } },
      expected: ["area needs text for display. Use a string or number."],
    },
    {
      label: "plain text area",
      change: { area: "Field Ops" },
      expected: [],
    },
    {
      label: "non-text label on the recommended option",
      change: {
        options: [
          { key: "a", label: { l: 1 } },
          { key: "b", label: "B" },
        ],
      },
      expected: [
        "The hub needs text to display the label and detail for option a. Set label and any detail to strings or numbers.",
      ],
    },
    {
      label: "option key containing a comma",
      change: {
        options: [
          { key: "a,b", label: "A" },
          { key: "b", label: "B" },
        ],
        recommended: "b",
      },
      expected: [
        'Option 1 has an invalid reference key "a,b". Set its key to a string or number without whitespace or commas.',
      ],
    },
    {
      // A numeric key is the key an images mapping names, 0 included.
      label: "numeric option keys matched by images mapping",
      change: {
        options: [
          { key: 0, label: "Zero" },
          { key: 1, label: "One" },
        ],
        recommended: 1,
        images: { 0: "a.png", 1: "b.png" },
      },
      expected: [],
    },
  ])("checks text fields, calendar dates, and option keys: $label", ({ change, expected }) => {
    expect(itemDefects({ ...valid, ...change } as unknown as Item, exists)).toEqual(expected);
  });

  test("usable drops invalid area and due date and stringifies numeric option keys", () => {
    const shown = usable({
      ...valid,
      options: [
        { key: 0, label: "Zero" },
        { key: 1, label: "One" },
      ],
      recommended: 1,
      area: { a: 1 },
      due: "2026-13-45",
    } as unknown as Item);
    expect([
      shown.area,
      shown.due,
      defined(shown.options, "displayed item options").map((o) => o.key),
      shown.recommended,
    ]).toEqual([undefined, undefined, ["0", "1"], ["1"]]);
  });

  test("a folder matching an image path is not accepted as an image", () => {
    const { defects: found } = readItems({
      paths: ["docs/agent-work/items/shot.md", "docs/agent-work/2026-01-01-r/a.png"],
      read: () =>
        "---\nkind: review\nstatus: open\npriority: 2\nowner: Alex\nimages: [docs/agent-work/2026-01-01-r]\n---\n# Shot\n",
    });
    expect(found).toEqual([
      "docs/agent-work/items/shot.md: The hub cannot display image docs/agent-work/2026-01-01-r. Add the missing file or fix its path in images.",
    ]);
  });

  test("a repeated top-level field is a defect naming the file and the field", () => {
    const { defects } = readItems({
      paths: ["docs/agent-work/items/twice.md"],
      read: () =>
        '---\nkind: work\nstatus: open\n"priority": 2\nowner: Alex\noptions:\n  - key: a\n    label: A\n  - key: b\n    label: B\npriority: 3\n---\n# Twice\n',
    });
    expect(defects).toEqual([
      "docs/agent-work/items/twice.md: Repeated frontmatter fields overwrite earlier values: priority. Keep each listed field once with the intended value.",
    ]);
  });

  test("the first heading supplies the title even when it ends the file", () => {
    const text = "---\nkind: goal\nstatus: open\n---\n\n#  Finish  ";
    expect(parseItem("finish", text)).toEqual({
      id: "finish",
      kind: "goal",
      status: "open",
      title: "Finish",
      body: "",
    });
  });

  test.each([
    [
      "An introduction\n---\nkind: work\n---\n# Move",
      "The check cannot read item fields without YAML frontmatter. Put the fields between two --- lines at the top of the item file.",
    ],
    [
      "---\n[work, open]\n---\n# Move",
      "The check reads item fields from a YAML mapping. Write each frontmatter field as a key-value pair, such as kind: goal.",
    ],
    [
      "---\nwork\n---\n# Move",
      "The check reads item fields from a YAML mapping. Write each frontmatter field as a key-value pair, such as kind: goal.",
    ],
    [
      "---\n[unfinished\n---\n# Move",
      "frontmatter: YAML Parse error: Unexpected token. Correct the YAML between the opening and closing --- lines in the item file.",
    ],
    [
      "---\nkind: work\n---\nIntro first.\n# Move",
      'The hub gets the item title from the first heading. Start the body after frontmatter with "# " followed by a nonempty title.',
    ],
    [
      "---\ncolour: red\nsize: big\n---\n# Move",
      "Unrecognized item fields: colour, size. Remove them or use a supported field from node_modules/@hackersandwizards/admin/docs/items.md.",
    ],
    [
      "---\nkind: work\nkind : review\n---\n# Move",
      "Repeated frontmatter fields overwrite earlier values: kind. Keep each listed field once with the intended value.",
    ],
  ])("reports the defect in an item file (%#)", (text, message) => {
    expect(() => parseItem("move", text)).toThrow(message);
  });

  test.each([
    [{ order: "first" }, "Order first cannot sort the item. Use a number for order or omit it."],
    [
      { options: "" },
      "Choices need a list. Write options as YAML list entries with key and label.",
    ],
    [
      { options: [null, { key: "b", label: "B" }] },
      "Option 1 needs a key for references and a label to display. Fill in both fields on that options entry.",
    ],
    [
      {
        options: [
          { key: "a", label: "" },
          { key: "b", label: "B" },
        ],
      },
      "Option 1 needs a key for references and a label to display. Fill in both fields on that options entry.",
    ],
    [
      {
        options: [
          { key: "a", label: "A" },
          { key: null, label: "B" },
        ],
      },
      "Option 2 needs a key for references and a label to display. Fill in both fields on that options entry.",
    ],
    [
      {
        options: [
          { key: "a", label: "A", detail: ["notes"] },
          { key: "b", label: "B" },
        ],
      },
      "The hub needs text to display the label and detail for option a. Set label and any detail to strings or numbers.",
    ],
    [
      {
        options: [
          { key: "a", label: "A", score: 8, noise: "small" },
          { key: "b", label: "B" },
        ],
      },
      "Noise requires a score for option a. Set both to numbers or omit noise.",
    ],
    [
      { status: "decided", decision: "Use A" },
      "Record what was decided and who decided it. Fill in decision and by.",
    ],
    [
      { status: "decided", by: "Alex" },
      "Record what was decided and who decided it. Fill in decision and by.",
    ],
    [
      { images: "one.png" },
      "The hub groups images by item or option. Use a list or mapping in images.",
    ],
  ])("reports a malformed item field (%#)", (change, message) => {
    expect(itemDefects({ ...valid, ...change } as Item, exists)).toContain(message);
  });

  test("an assumption can stand on its own and a settled item can name who decided", () => {
    const review = {
      ...valid,
      kind: "review" as const,
      options: undefined,
      recommended: undefined,
    };
    expect(
      itemDefects({ ...review, status: "assumed", assumption: "Hold for now" }, exists),
    ).toEqual([]);
    expect(
      itemDefects({ ...review, status: "decided", decision: "Hold", by: "Alex" }, exists),
    ).toEqual([]);
    expect(
      itemDefects(
        { id: "finish", title: "Finish", body: "", kind: "goal", status: "open" },
        exists,
      ),
    ).toEqual([]);
  });

  test("a defective option or image does not hide the usable options and images", () => {
    const item = usable({
      ...valid,
      owner: 42,
      evidence: 7,
      due: "2026-02-30",
      options: [
        null,
        { key: "", label: "No key" },
        { key: "a", label: { invalid: true }, detail: 17 },
        { key: "b", label: "Keep B", detail: "A note" },
      ],
      images: {
        a: ["angle.jpg", { src: "docs/shared.jpg", caption: "Close-up" }, null, { src: 2 }],
        b: "other.jpg",
      },
    } as unknown as Item);
    expect(item).toMatchObject({
      priority: 2,
      owner: "42",
      evidence: "7",
      due: undefined,
      recommended: ["a"],
    });
    expect(item.options).toEqual([
      { key: "a", label: "a", detail: "17" },
      { key: "b", label: "Keep B", detail: "A note" },
    ]);
    expect(item.images).toEqual({
      a: ["angle.jpg", { src: "docs/shared.jpg", caption: "Close-up" }],
      b: ["other.jpg"],
    });
    expect(imagesOf(item)).toEqual({
      a: [
        { src: "docs/agent-work/items/a-question/angle.jpg" },
        { src: "docs/shared.jpg", caption: "Close-up" },
      ],
      b: [{ src: "docs/agent-work/items/a-question/other.jpg" }],
    });
    expect(usable({ ...valid, images: "one.png", options: "A" } as unknown as Item)).toMatchObject({
      options: undefined,
      images: undefined,
    });
  });
});

describe("Mermaid in Markdown", () => {
  const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\`\n`;
  const flow = fence("flowchart LR\n  a --> b");
  const render = (text: string) => renderDocMarkdown("/r", "docs/a.md", text);

  test("renders inline SVG without remote fonts", () => {
    const html = render(flow);
    expect(html).toContain('<figure class="admin-diagram not-prose" tabindex="0"><svg');
    expect(html).toContain('data-to="b"');
    expect(html).not.toMatch(/@import|googleapis|font-family|<pre/);
  });

  test("diagrams share no id within or across documents", () => {
    const text = flow + "\n" + flow;
    const first = render(text);
    const others = [
      render("# Other document\n\n" + flow),
      renderDocMarkdown("/r", "docs/b.md", flow),
    ];
    expect(render(text)).toBe(first);
    const ids = [...[first, ...others].join("").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const markers = [...[first, ...others].join("").matchAll(/marker-end="url\(#([^)]+)\)"/g)];
    expect(markers).toHaveLength(4);
    for (const [, id] of markers) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("items with the same body have distinct diagram ids", async () => {
    const body = `---\nkind: work\nstatus: open\npriority: 1\n---\n# Archive samples\n\n${flow}`;
    const repo = await fromFiles({
      "docs/agent-work/items/draft.md": body,
      "docs/agent-work/items/archive.md": body,
    });
    const ids = defined(siteData([repo]).repos[0], "first rendered repository").items.map(
      ({ html }) => html.match(/<svg id="([^"]+)"/)?.[1],
    );
    expect(ids).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(ids).size).toBe(2);
  });

  test("an item links paths and URLs in prose and leaves SVG labels as text", async () => {
    const path = "docs/agent-work/guide.md";
    const url = "https://example.invalid/guide";
    const body = `${path}\n\n${url}\n\n${fence(`flowchart LR\n  a["${path}"] --> b["${url}"]`)}`;
    const repo = await fromFiles({
      [path]: "# Guide",
      "docs/agent-work/items/archive.md": `---\nkind: work\nstatus: open\npriority: 1\n---\n# Archive samples\n\n${body}`,
    });
    const html = withLinks(
      defined(
        defined(siteData([repo]).repos[0], "first rendered repository").items[0],
        "item at index 0",
      ).html,
    );
    const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0];
    expect(svg).toContain(`>${path}</text>`);
    expect(svg).toContain(`>${url}</text>`);
    expect(svg).not.toContain("<a ");
    expect(html).toContain(`href="file:///nonexistent/x/${path}">${path}</a>`);
    expect(html).toContain(`href="${url}">${url}</a>`);
  });

  test("drops flowchart styling and directives", () => {
    const html = render(
      fence(
        [
          "%%{init: {",
          '  "theme": "forest"',
          "}}%%",
          "flowchart LR",
          "a --> b",
          "classDef tinted fill:#ff00ff",
          "class a tinted",
          "class b tinted;",
          "style b fill:#00ffff",
          "linkStyle 0 stroke:#ff0000",
          "&#115;tyle a fill:#00ff00",
        ].join("\n"),
      ),
    );
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/forest|#ff00ff|#00ffff|#ff0000|#00ff00/);
    expect(html).not.toContain('data-id="class"');
  });

  test("keeps declarations in a class diagram", () => {
    const html = render(fence("%% A diagram\nclassDiagram\n  class Sample\n  class Folder"));
    expect(html).toContain('class="class-node" data-id="Sample"');
    expect(html).toContain('class="class-node" data-id="Folder"');
  });

  test("keeps unsupported Mermaid as code with an escaped error", () => {
    const html = render(fence("pie <em>Samples</em>"));
    expect(html).toContain('<code class="language-mermaid">pie &lt;em&gt;Samples&lt;/em&gt;');
    expect(html).toMatch(/<p>This diagram did not render: [^<]*pie &lt;em&gt;Samples&lt;\/em&gt;/);
  });

  test("keeps markup in labels as text and strips click actions", () => {
    const html = render(
      fence(
        [
          "flowchart LR",
          'a["<script>alert(1)</script>"] --> b',
          'click a "https://example.invalid/"',
          "click b callback",
        ].join("\n"),
      ),
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script|<a\b|href=|\son\w+=|callback|example\.invalid/);
    expect(html).not.toContain('data-id="click"');
  });
});

describe("admin-check", () => {
  test.each([
    ["draft", "draft"],
    ["[2026-01-15-sample-topic]", "2026-01-15-sample-topic"],
    ["2026-01-15-notes.html", "2026-01-15-notes.html"],
    ['"2026-01-15-hash#note"', "2026-01-15-hash#note"],
    ["2026-01-15-question?", "2026-01-15-question?"],
    ["2026-01-15-First draft", "2026-01-15-First draft"],
    [String.raw`"2026-01-15-two\nlines"`, "2026-01-15-two\nlines"],
  ])("admin-check refuses non-plain topic %s even when its file exists", (topic, stem) => {
    const path = "docs/agent-work/items/draft.md";
    const files: Record<string, string> = {
      [path]: `---\nkind: work\nstatus: open\npriority: 1\nowner: an agent\ntopic: ${topic}\n---\n# Draft\n`,
      [`docs/agent-work/${stem}.md`]: "# Sample report\n",
    };
    const { defects, items } = readItems({
      paths: Object.keys(files),
      read: (file) => files[file],
    });
    expect(defects.join("\n")).toContain(`${path}: topic must be a plain report name`);
    expect(defects.join("\n")).toContain("Rename the report or correct the field");
    expect(items[0]?.topic).toBeUndefined();
  });

  test("admin-check refuses a plain topic with no report", () => {
    const path = "docs/agent-work/items/draft.md";
    const text =
      "---\nkind: work\nstatus: open\npriority: 1\nowner: an agent\ntopic: 2026-01-15-missing\n---\n# Draft\n";
    const { defects } = readItems({ paths: [path], read: () => text });
    expect(defects.join("\n")).toContain(
      `${path}: topic report docs/agent-work/2026-01-15-missing.md not found`,
    );
  });

  test("admin-check accepts the exact name of a plain dated report in the same repository", () => {
    const topic = "2026-01-15-first-draft";
    const path = "docs/agent-work/items/draft.md";
    const files: Record<string, string> = {
      [path]: `---\nkind: work\nstatus: open\npriority: 1\nowner: an agent\ntopic: ${topic}\n---\n# Draft\n`,
      [`docs/agent-work/${topic}.md`]: "# First draft\n",
    };
    const { items, defects } = readItems({
      paths: Object.keys(files),
      read: (file) => files[file],
    });
    expect(defects).toEqual([]);
    expect(items[0]?.topic).toBe(topic);
  });

  test("Markdown headings have distinct ids in a document and none in an item", () => {
    const text = "# Copy\n\n## Same\n\n## Same\n\n### Same-1\n";
    const ids = (render: (repo: string, path: string, text: string) => string) =>
      [...render("/r", "docs/a.md", text).matchAll(/id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids(renderDocMarkdown)).toEqual(["section-copy", "same", "same-1", "same-1-1"]);
    expect(ids(renderItemMarkdown)).toEqual([]);
  });

  test("a raw h1 keeps its id when an earlier attribute contains a greater-than sign", async () => {
    const repo = await fromFiles({
      "docs/title.md": '<h1 title="2 > 1" id="named">Sample title</h1>\n\nBody.\n',
    });
    expect(repo.docs).toEqual([
      { path: "docs/title.md", title: "Sample title", titleId: "named", html: "<p>Body.</p>\n" },
    ]);
  });

  test("the spoke fixture is clean", () => {
    const { items, defects } = readItems(treeSource(join(FIX, "spoke")));
    expect(defects).toEqual([]);
    expect(items.find((i) => i.id === "pick-a-variant")?.topic).toBe("2026-01-15-sample-topic");
    expect(
      items.map((i) => [i.id, i.needs] as const).toSorted(([a], [b]) => a.localeCompare(b)),
    ).toEqual([
      ["ask-the-printer", undefined],
      ["cache-folder", ["pick-a-variant"]],
      ["check-the-copy", ["pick-a-variant"]],
      ["goal", undefined],
      ["name-the-command", ["goal"]],
      ["pick-a-logo", undefined],
      ["pick-a-variant", undefined],
      ["pick-recipients", undefined],
      ["sort-the-samples", undefined],
      ["work-wire-the-gate", ["check-the-copy", "cache-folder", "name-the-command"]],
    ]);
  });

  test("a Markdown link goes out only over http(s), to mailto or to a path; any other scheme shows its text", () => {
    const bad = [
      "[a](javascript:alert(1))",
      "[b](JaVaScRiPt:x)",
      "<javascript:alert(1)>",
      "[c](data:text/html,x)",
      "[d](file:///etc/hosts)",
      "[e](vscode://file/x)",
      "[f](&#106;avascript:x)",
      "[g][r]\n\n[r]: javascript:x",
    ];
    for (const md of bad)
      for (const render of [renderDocMarkdown, renderItemMarkdown])
        expect(render("/r", "docs/a.md", md)).not.toContain("<a ");
    // Raw HTML in a doc, quoted any way, with an entity or a space the browser drops.
    for (const raw of [
      '<a href="javascript:x">t</a>',
      "<a href='javascript:x'>t</a>",
      "<a href=javascript:x>t</a>",
      '<a title="x" href="&#106;avascript:x">t</a>',
      '<a href="javascript&colon;x">t</a>',
      '<a href=" javascript:x">t</a>',
      '<a href="java&#x09;script:x">t</a>',
      '<a\nhref="javascript:x">t</a>',
      '<A HREF="javascript:x">t</A>',
      '<a href ="javascript:x">t</a>',
      '<p><a href="javascript:x">t</p>',
      '<a title=" href=https://a.test/" href="javascript:x">t</a>',
      '<a href="https://a.test/">see [x](javascript:x)',
      '<map><area href="javascript:x"></map>',
      '<svg><a xlink:href="javascript:x"><text>t</text></a></svg>',
      '<svg><a href="" xlink:href="javascript:x"><text>t</text></a></svg>',
      '<svg><a><set attributeName="href" to="javascript:x"/><text>t</text></a></svg>',
      '<svg><a><animate attributeName="xlink:href" values="javascript:x"/><text>t</text></a></svg>',
    ])
      expect(renderDocMarkdown("/r", "docs/a.md", raw)).not.toMatch(
        /href\s*=\s*(?!["']?\s*https:)|javascript/i,
      );
    const ok = renderDocMarkdown(
      "/r",
      "docs/a.md",
      "[h](https://a.test/) [i](HTTP://a.test/) [m](mailto:x@a.test) [p](b.md#t) [q](/b.md) [s](#t) [a](q&a.md) [t](10:30.md)",
    );
    expect(ok.match(/<a /g)).toHaveLength(8);
    expect(ok).toContain('href="file:///r/docs/b.md#t"');
  });

  test("a stray % in a Markdown link stays as written", () => {
    expect(renderDocMarkdown("/r", "docs/a.md", "[half](50%.md)")).toContain("docs/50%25.md");
  });

  test("a task list wears no marker beside its read-only hw-check boxes", () => {
    const html = renderDocMarkdown(
      "/r",
      "docs/a.md",
      "- [ ] open\n- [x] done\n\nNext:\n\n- plain\n",
    );
    expect(html.match(/hw-marker-list/g)).toHaveLength(1);
    expect(html).toContain('<ul>\n<li class="task-list-item">');
    expect(
      html.match(/class="task-list-item-checkbox hw-check" data-readonly disabled/g),
    ).toHaveLength(2);
  });

  const taskBox = '<input type="checkbox" class="task-list-item-checkbox hw-check" data-readonly';

  test.each([
    {
      label: "tight and nested task items",
      markdown: "- [x] done **now**\n  - [ ] nested\n",
      expected: `<label>${taskBox} disabled checked>done <strong>now</strong></label>\n<ul>\n<li class="task-list-item"><label>${taskBox} disabled>nested</label></li>`,
    },
    {
      label: "loose task item with continuation paragraph",
      markdown: "- [ ] loose\n\n  more\n\n- [x] next\n",
      expected: `<p><label>${taskBox} disabled>loose</label></p>\n<p>more</p>`,
    },
    {
      label: "task item followed by blockquote",
      markdown: "- [ ] see\n  > quoted\n",
      expected: `<label>${taskBox} disabled>see</label>\n<blockquote`,
    },
    {
      label: "task item with wrapped inline link",
      markdown: "- [ ] a [link\n  **b**](x.md) end\n",
      expected: "</strong></a> end</label>",
    },
    {
      label: "task item followed by fenced code block",
      markdown: "- [ ] run\n  ```\n  x\n  ```\n",
      expected: `<label>${taskBox} disabled>run</label>\n<pre`,
    },
    {
      label: "task item followed by mermaid diagram",
      markdown: "- [ ] check diagram\n  ```mermaid\n  flowchart LR\n    a --> b\n  ```\n",
      expected: `<label>${taskBox} disabled>check diagram</label>\n<figure`,
    },
  ])("wraps each task checkbox label cleanly: $label", ({ markdown, expected }) => {
    expect(renderDocMarkdown("/r", "docs/a.md", markdown)).toContain(expected);
  });
});

describe("hub", () => {
  test("front matter is a leading YAML mapping; a leading rule stays in the doc", () => {
    const html = (text: string) => renderDocMarkdown("/r", "docs/a.md", text);
    expect(html("---\n\nintro\n\n---\n\nrest\n")).toContain("intro");
    expect(html("---\ntitle: x\n---\n\nrest\n")).not.toContain("title");
  });

  type Hast = {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: Hast[];
  };
  const dom = (html: string) => {
    const body = new Window().document.body;
    body.innerHTML = html;
    return body;
  };
  const hastByNodeType = new Map<number, (n: DomNode) => Hast>([
    [
      3,
      (n) => {
        assert(typeof n.textContent === "string", "text node content");
        return { type: "text", value: n.textContent };
      },
    ],
    [
      1,
      (n) => {
        const el = n as DomEl;
        return {
          type: "element",
          tagName: el.localName,
          properties: { className: [...el.classList] },
          children: [...el.childNodes].map(toHast),
        };
      },
    ],
  ]);
  const toHast = (n: DomNode): Hast => {
    const build = hastByNodeType.get(n.nodeType);
    assert(build, `unexpected DOM nodeType ${n.nodeType}`);
    return build(n);
  };
  const scrollWrapper = (ariaLabel: string) => ({
    type: "element",
    tagName: "div",
    properties: { className: ["hw-table-scroll"], ariaLabel },
  });

  test("a table's wrapper is named as brand's tableScroll names it", () => {
    const table = (head: string) => `| ${head} | B |\n| - | - |\n| 1 | 2 |\n\n`;
    const text = `${table("A **b**")}${table("A b")}## Prices\n\n${table("x")}${table("y")}<H3>Raw "q" &amp; <i>it</i></H3>\n\n${table("z")}# Next\n\n| |\n|-|\n|1|\n\n## Prices\n\n${table("w")}`;
    const ours = [
      ...dom(renderDocMarkdown("/r", "docs/a.md", text)).querySelectorAll(".hw-table-scroll"),
    ].map((w) => w.getAttribute("aria-label"));
    const root: Hast = {
      type: "root",
      children: [...dom(Bun.markdown.html(text)).childNodes].map(toHast),
    };
    brandTableScroll()(root);
    const expectedLabels = [
      "A b B",
      "A b B (2)",
      "Prices",
      "Prices (2)",
      'Raw "q" & it',
      "Next",
      "Prices (3)",
    ];
    expect(root.children).toMatchObject([
      scrollWrapper("A b B"),
      { type: "text" },
      scrollWrapper("A b B (2)"),
      { type: "text" },
      { type: "element", tagName: "h2" },
      { type: "text" },
      scrollWrapper("Prices"),
      { type: "text" },
      scrollWrapper("Prices (2)"),
      { type: "text" },
      { type: "element", tagName: "h3" },
      { type: "text" },
      scrollWrapper('Raw "q" & it'),
      { type: "text" },
      { type: "element", tagName: "h1" },
      { type: "text" },
      scrollWrapper("Next"),
      { type: "text" },
      { type: "element", tagName: "h2" },
      { type: "text" },
      scrollWrapper("Prices (3)"),
      { type: "text" },
    ]);
    expect(JSON.stringify(root).split('"hw-table-scroll"')).toHaveLength(8);
    expect(ours).toEqual(expectedLabels);
  });

  test("a table without a heading or column names gets no aria-label", () => {
    const markdown = "| |\n|-|\n|1|\n";
    const ours = [
      ...dom(renderDocMarkdown("/r", "docs/a.md", markdown)).querySelectorAll(".hw-table-scroll"),
    ].map((w) => w.getAttribute("aria-label"));
    const root: Hast = {
      type: "root",
      children: [...dom(Bun.markdown.html(markdown)).childNodes].map(toHast),
    };
    brandTableScroll()(root);
    expect(root.children).toMatchObject([
      {
        type: "element",
        tagName: "div",
        properties: { className: ["hw-table-scroll"], tabIndex: 0 },
      },
      { type: "text" },
    ]);
    expect(
      defined(defined(root.children, "tree children")[0], "first tree child").properties,
    ).toEqual({
      className: ["hw-table-scroll"],
      tabIndex: 0,
    });
    expect(JSON.stringify(root).split('"hw-table-scroll"')).toHaveLength(2);
    expect(ours).toEqual([null]);
  });

  test("a table holding another leaves the wrapper to the inner one", () => {
    const html = renderDocMarkdown(
      "/r",
      "docs/a.md",
      "<table><tr><td><table><tr><td>in</td></tr></table></td><td>x</td></tr></table>\n",
    );
    expect(html).toContain('<td><div class="hw-table-scroll"');
    expect(html).toContain("</table></div></td>");
    expect(
      renderDocMarkdown("/r", "docs/a.md", '<table class="x"><tr><td>a</td></tr></table>\n'),
    ).toContain(
      '<div class="hw-table-scroll" tabindex="0" role="region" aria-label="a"><table class="x">',
    );
  });
});

describe("repository data", () => {
  const readFiles = (files: Record<string, string>) =>
    readRepo("/nonexistent/paint samples", {
      paths: Object.keys(files),
      read: (path) => files[path],
    });

  test("counts commits behind the branch a checkout pushes to", async () => {
    const origin = repoFrom("spoke");
    const clone = join(dirname(origin), "clone");
    sh(dirname(origin), "git", "clone", "-q", origin, clone);
    sh(clone, "git", "config", "push.default", "current");
    writeFileSync(join(origin, "extra.md"), "# Extra\n");
    sh(origin, "git", "add", "extra.md");
    commit(origin, "extra");
    sh(clone, "git", "fetch", "-q");
    expect((await readRepo(clone)).behind).toBe(1);
    // This branch tracks origin/main but would push to origin/local.
    sh(clone, "git", "checkout", "-q", "-b", "local", "--track", "origin/main");
    expect((await readRepo(clone)).behind).toBeUndefined();
  });

  describe("committed history and working tree readers", () => {
    const report = "docs/agent-work/2026-01-14-first draft.md";
    const fetched = new Date("2026-01-15T10:00:00Z");
    const time = Date.parse("2026-01-14T12:34:00Z") / 1000;
    const pkgTime = Date.parse("2026-01-14T12:35:00Z") / 1000;
    let repo: string;
    let trackingHash: string;
    let tree: ReturnType<typeof treeSource>;
    let committed: Awaited<ReturnType<typeof readRepo>>;

    beforeAll(async () => {
      const generated = join(import.meta.dirname, "../node_modules/.cache");
      mkdirSync(generated, { recursive: true });
      repo = mkdtempSync(join(generated, "admin-repo-"));
      const gitAt = (whenIso: string, ...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], {
          cwd: repo,
          env: {
            ...gitEnv,
            GIT_AUTHOR_DATE: whenIso,
            GIT_COMMITTER_DATE: whenIso,
          },
        });
        assert.strictEqual(result.exitCode, 0, result.stderr.toString());
        return result.stdout.toString().trim();
      };
      gitAt("2026-01-14T12:34:00Z", "init", "-q");
      const work = "docs/agent-work/items/ship.md";
      await Bun.write(join(repo, report), "# First draft\n");
      await Bun.write(
        join(repo, work),
        "---\nkind: work\nstatus: open\npriority: 1\nowner: Alex\n---\n# Ship the samples",
      );
      await Bun.write(join(repo, ".gitignore"), "ignored.txt\n");
      await Bun.write(join(repo, "docs/note.md"), "# First note\n\nCafé");
      await Bun.write(join(repo, "docs/next.md"), "# Next note\n\nTwo");
      gitAt("2026-01-14T12:34:00Z", "add", "--", ".gitignore", "docs");
      gitAt(
        "2026-01-14T12:34:00Z",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "Write notes",
      );
      trackingHash = gitAt("2026-01-14T12:34:00Z", "rev-parse", "--short", "HEAD");
      await Bun.write(join(repo, "package.json"), '{"name":"paint","version":"1.0.0"}');
      gitAt("2026-01-14T12:35:00Z", "add", "--", "package.json");
      gitAt(
        "2026-01-14T12:35:00Z",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "Add package",
      );
      const fetch = join(repo, ".git/FETCH_HEAD");
      await Bun.write(fetch, "");
      utimesSync(fetch, fetched, fetched);
      await Bun.write(join(repo, "docs/note.md"), "# Edited note\n\nDraft");
      await Bun.write(join(repo, "ignored.txt"), "Generated");
      await Bun.write(join(repo, "docs/draft.md"), "# Draft");
      rmSync(join(repo, "docs/next.md"));
      tree = treeSource(repo);
      committed = await readRepo(repo);
    });

    afterAll(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    test("treeSource reads working-tree edits and omits gitignored or deleted files", () => {
      expect(tree.paths.toSorted()).toEqual([
        ".gitignore",
        report,
        "docs/agent-work/items/ship.md",
        "docs/draft.md",
        "docs/note.md",
        "package.json",
      ]);
      expect(tree.read("docs/note.md")).toBe("# Edited note\n\nDraft");
      expect(tree.read("docs/next.md")).toBeUndefined();
    });

    test("readRepo records the FETCH_HEAD modification time", () => {
      expect(committed.fetched).toBe(fetched.getTime());
    });

    test("readRepo leaves commits behind unset without an upstream", () => {
      expect(committed.behind).toBeUndefined();
    });

    test("readRepo reads HEAD and the full commit log", () => {
      expect(committed.head).toMatch(/^[a-f0-9]{7,}$/);
      expect(committed.log).toEqual([
        { hash: committed.head, time: pkgTime, subject: "Add package" },
        { hash: trackingHash, time, subject: "Write notes" },
      ]);
    });

    test("readRepo restricts trackingLog to commits touching docs/agent-work", () => {
      expect(committed.trackingLog).toEqual([{ hash: trackingHash, time, subject: "Write notes" }]);
    });

    test("readRepo reads committed reports with change time and content hash", () => {
      expect(committed.reports).toMatchObject([
        { path: report, changed: time, version: "29j6lxvxj0p1b" },
      ]);
    });

    test("readRepo reads committed items with change time", () => {
      expect(committed.items).toMatchObject([
        { id: "ship", title: "Ship the samples", changed: time },
      ]);
    });

    test("readRepo reads committed docs at HEAD including working-tree deletions", () => {
      expect(committed.docs).toEqual([
        { path: "docs/next.md", title: "Next note", titleId: "next-note", html: "<p>Two</p>\n" },
        { path: "docs/note.md", title: "First note", titleId: "first-note", html: "<p>Café</p>\n" },
      ]);
    });

    test("readRepo reads committed package metadata with no defects", () => {
      expect(committed.pkg).toMatchObject({ name: "paint", version: "1.0.0" });
      expect(committed.defects).toEqual([]);
    });
  });

  test("a source outside Git still reads its docs and leaves generated folders alone", () => {
    const generated = join(import.meta.dirname, "../node_modules/.cache");
    mkdirSync(generated, { recursive: true });
    const dir = mkdtempSync(join(generated, "admin-tree-"));
    try {
      mkdirSync(join(dir, ".git"));
      mkdirSync(join(dir, "node_modules"));
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, ".git/private"), "internal");
      writeFileSync(join(dir, "node_modules/cache"), "generated");
      writeFileSync(join(dir, "docs/guide.md"), "# Guide");
      const tree = treeSource(dir);
      expect(tree.paths).toEqual(["docs/guide.md"]);
      expect(tree.read("docs/guide.md")).toBe("# Guide");
      expect(tree.read("docs/missing.md")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("repository publication", () => {
    const report = "docs/agent-work/2026-01-14-paint";
    let repo: Awaited<ReturnType<typeof readFiles>>;

    beforeAll(async () => {
      repo = await readFiles({
        "package.json": JSON.stringify({
          name: "paint",
          version: "2.0.0",
          scripts: { "check:all": " format &&  test && ", check: "lint" },
          dependencies: { tint: "1.0.0" },
          devDependencies: { sampler: "2.0.0" },
          bin: "./scripts/paint.ts",
          admin: {
            name: "paint.samples",
            label: "  Paint samples  ",
            designSystem: "https://paint.example/catalog/",
            products: [
              { label: "Tiles", description: "Browse the colors", href: "docs/tiles.html" },
              null,
            ],
            links: [{ label: "Guide", href: "docs/guide.md?print=1#start" }, { label: "Unlinked" }],
          },
        }),
        "docs/agent-work/admin.json": '{"label":"Old label"}',
        "README.md": "# Read me\n\nStart",
        "docs/guide.md": "# Tool &amp; *guide*\n\nInstructions",
        [`${report}.md`]: "# Sample review\n\nComparison",
        [`${report}/z.PNG`]: "",
        [`${report}/a.webp`]: "",
        [`${report}/notes.txt`]: "",
        "docs/agent-work/2026-01-15-next.md": "Planning",
        "docs/agent-work/2026-01-15-next/first.jpg": "",
        "scripts/paint.ts": "// Render color samples\n",
        "scripts/other.sh": "#!/bin/sh\n# Export samples\n",
        ".claude/agents/help.md": "---\ndescription: Mira, who samples paint\n---\n",
        ".claude/agents/tool.md": "---\ndescription: Tool instructions\n---\n",
      });
    });

    test("publishes the configured admin.name as repository key", () => {
      expect(repo.key).toBe("paint.samples");
    });

    test("trims whitespace around the configured admin.label", () => {
      expect(repo.label).toBe("Paint samples");
    });

    test("publishes package metadata with merged dependencies and string bin", () => {
      expect(repo.pkg).toMatchObject({
        name: "paint",
        version: "2.0.0",
        dependencies: { tint: "1.0.0", sampler: "2.0.0" },
        bin: { paint: "./scripts/paint.ts" },
      });
    });

    test("reports docs/agent-work/admin.json ignored when package.json carries valid admin", () => {
      expect(repo.defects).toEqual([
        "docs/agent-work/admin.json: ignored, package.json holds admin",
      ]);
    });

    test("publishes an explicit designSystem URL without a dev server", () => {
      expect(repo).toMatchObject({
        designSystem: "https://paint.example/catalog/",
        designSystemDev: undefined,
      });
    });

    test("publishes check steps from check:all", () => {
      expect(repo.checkSteps).toEqual(["format", "test"]);
    });

    test("publishes colleague names from agent definitions", () => {
      expect(repo.agents).toEqual(["Mira"]);
    });

    test.each([
      [
        "products",
        [
          {
            label: "Tiles",
            description: "Browse the colors",
            href: "file:///nonexistent/paint%20samples/docs/tiles.html",
          },
        ],
      ],
      [
        "links",
        [
          {
            label: "Guide",
            href: "file:///nonexistent/paint%20samples/docs/guide.md?print=1#start",
          },
        ],
      ],
    ] as const)(
      "publishes valid %s with resolved file hrefs and drops incomplete entries",
      (field, expected) => {
        expect(repo[field]).toEqual(expected);
      },
    );

    test("publishes scripts with their leading comments", () => {
      expect(repo.scripts).toEqual([
        { path: "scripts/paint.ts", comment: "Render color samples" },
        { path: "scripts/other.sh", comment: "Export samples" },
      ]);
    });

    test("publishes docs sorted by path with extracted titles", () => {
      expect(repo.docs).toEqual([
        {
          path: "docs/guide.md",
          title: "Tool & guide",
          titleId: "tool-guide",
          html: "<p>Instructions</p>\n",
        },
        { path: "README.md", title: "Read me", titleId: "read-me", html: "<p>Start</p>\n" },
      ]);
    });

    test("publishes dated reports sorted newest first with content hashes", () => {
      expect(repo.reports).toEqual([
        {
          path: "docs/agent-work/2026-01-15-next.md",
          stem: "2026-01-15-next",
          date: "2026-01-15",
          title: "2026-01-15-next",
          changed: undefined,
          version: "1wtv1saywapf5",
          html: "<p>Planning</p>\n",
        },
        {
          path: `${report}.md`,
          date: "2026-01-14",
          title: "Sample review",
          titleId: "sample-review",
          stem: "2026-01-14-paint",
          changed: undefined,
          version: "1n50oecivccm7",
          html: "<p>Comparison</p>\n",
        },
      ]);
    });

    test("publishes dated review folders with sorted images and linked reports", () => {
      expect(repo.reviews).toEqual([
        {
          dir: "docs/agent-work/2026-01-15-next",
          images: ["first.jpg"],
          report: "docs/agent-work/2026-01-15-next.md",
        },
        { dir: report, images: ["a.webp", "z.PNG"], report: `${report}.md` },
      ]);
    });
  });

  test("bad package fields report defects while a usable catalog can still be inferred", async () => {
    const repo = await readFiles({
      "package.json": JSON.stringify({
        scripts: { dev: "astro dev", "design-system": "astro dev --root catalog", missing: 1 },
        bin: { paint: "./paint.ts", broken: true },
        dependencies: ["wrong"],
        admin: { name: "...", label: 17 },
      }),
      "astro.config.ts": "export default { server: { port: 4329 } }",
      "catalog/astro.config.mjs":
        'import { astrobook } from "astrobook"; export default { base: "/paint", subpath: "/examples/", server: { port: 4556 } }',
    });
    expect(repo).toMatchObject({
      key: "paint-samples",
      label: undefined,
      designSystem: "http://127.0.0.1:4556/paint/examples/",
      designSystemDev: { port: 4556, start: "design-system" },
      pkg: {
        scripts: { dev: "astro dev", "design-system": "astro dev --root catalog" },
        bin: { paint: "./paint.ts" },
        dependencies: {},
      },
    });
    expect(repo.defects).toEqual([
      'package.json: admin.name "..." is not letters, digits, ".", "_" and "-": its pages are under paint-samples',
      "package.json: admin.label is not text",
      "package.json: scripts holds a value that is not text",
      "package.json: dependencies holds a value that is not text",
      "package.json: bin holds a value that is not text",
    ]);
  });

  test.each([
    ["", "{}", ["package.json: not JSON"]],
    ["[", "[]", ["package.json: not JSON", "docs/agent-work/admin.json: not a JSON object"]],
    ["[]", "x", ["package.json: not an object", "docs/agent-work/admin.json: not JSON"]],
    [
      '{"admin":5}',
      '{"label":"Fallback"}',
      [
        "package.json: admin is not an object",
        "docs/agent-work/admin.json: ignored, package.json holds admin",
      ],
    ],
  ])(
    "configuration errors do not take down the repository view (%#)",
    async (pkg, admin, defects) => {
      const repo = await readFiles({ "package.json": pkg, "docs/agent-work/admin.json": admin });
      expect(repo).toMatchObject({
        key: "paint-samples",
        label: undefined,
        items: [],
        links: [],
        products: [],
      });
      expect(repo.defects).toEqual(defects);
    },
  );

  test("a standalone admin config supplies a label and links without a package", async () => {
    const repo = await readFiles({
      "docs/agent-work/admin.json": JSON.stringify({
        label: "Paint samples",
        links: [{ label: "Catalogue", href: "https://paint.example/" }],
      }),
    });
    expect(repo).toMatchObject({
      key: "paint-samples",
      label: "Paint samples",
      links: [{ label: "Catalogue", href: "https://paint.example/" }],
      defects: [],
    });
  });

  test("image tiles offer sizes for both screen densities", () => {
    const href = "file:///paint%20samples/docs/a%3Fb%26c%23.png";
    expect(thumbnail(href)).toEqual({
      src: `${href}?w=480`,
      srcset: `${href}?w=480 480w, ${href}?w=960 960w`,
      sizes: "auto, 50vw",
    });
    inZone("UTC", () =>
      expect(when(Date.parse("2026-01-10T09:05:00Z"))).toMatch(/^10 Jan(?: at|,) 09:05$/),
    );
  });

  test("headings with attributes name tables and code blocks retain their own styling", () => {
    const html = renderDocMarkdown(
      "/r",
      "docs/guide.md",
      '<h2 id="sizes">Paint  sizes</h2>\n\n<table><tr><th id="size">Size</th></tr><tr><td>10</td></tr></table>\n\n`one`\n\n```text\ntwo\n```',
    );
    expect(html).toContain('aria-label="Paint sizes"');
    expect(html).toContain('<code class="hw-inline-code">one</code>');
    expect(html).toContain(
      '<pre class="hw-code not-prose"><code class="language-text">two\n</code></pre>',
    );
  });
});

describe("pages", () => {
  test("a relative link's decoded query or fragment writes no markup", () => {
    const html = renderDocMarkdown(
      "/r",
      "docs/x.md",
      `<p>href="x?&#60;a href=javascript:alert(1)&#62;c&#60;/a&#62;"</p>\n\n` +
        `<img alt='src="y?&#39; onerror=alert(1) x=&#39;"' src=z.png>`,
    );
    expect(html).not.toMatch(/<a |' onerror/);
  });

  test("a named entity in a relative link's fragment stays encoded", () => {
    expect(renderDocMarkdown("/r", "docs/x.md", `<a href="x.md#a&quot;b">r</a>`)).toContain(
      'href="file:///r/docs/x.md#a&quot;b"',
    );
  });

  test("a leading whitespace entity before an address or fragment stays as written", () => {
    const lead = renderDocMarkdown(
      "/r",
      "docs/x.md",
      `<a href="&#32;https://a.test/">a</a><a href="&#9;#t">t</a>`,
    );
    expect(lead).toContain('href="&#32;https://a.test/"');
    expect(lead).toContain('href="&#9;#t"');
  });

  test("upper-case standard entities decode in relative links while mixed-case or non-standard names do not", () => {
    // A browser reads &AMP;, &LT;, &GT; and &QUOT; as their lower-case names, and &Amp; or &APOS;
    // as text.
    const upper = renderDocMarkdown(
      "/r",
      "docs/x.md",
      `<a href="q&AMP;a.md">q</a><img src="x&Amp;y.png"><a href="b&APOS;c.md">b</a>`,
    );
    expect(upper).toContain('href="file:///r/docs/q%26a.md"');
    expect(upper).toContain('src="file:///r/docs/x%26Amp;y.png"');
    expect(upper).toContain(">b</p>");
    expect(upper).not.toContain("APOS");
  });

  const dueNow = new Date(2026, 10, 10, 12).getTime();

  test.each([
    ["2026-11-10", { text: "due today", tone: "today" }],
    ["2026-11-03", { text: "was due 3 Nov", tone: "overdue" }],
    ["2026-11-13", { text: "due 13 Nov", tone: "soon" }],
    ["2026-12-13", { text: "due 13 Dec", tone: "later" }],
    // A day more than 300 days away names its year, ahead as behind.
    ["2027-12-01", { text: "due 1 Dec 2027", tone: "later" }],
  ])("dueOf formats text and tone for %s", (due, expected) => {
    expect(dueOf(due, dueNow)).toEqual(expected);
  });

  test("dueOf names the written calendar day west of UTC", () => {
    inZone("America/New_York", () =>
      expect(dueOf("2026-11-20", new Date(2026, 10, 10, 12).getTime()).text).toBe("due 20 Nov"),
    );
  });

  test.each([
    {
      label: "code spans, escaped HTML, and bare URLs",
      input: "use `a-b` & <i>, see http://127.0.0.1:4329/x.",
      expected:
        'use <code class="hw-inline-code">a-b</code> &amp; &lt;i&gt;, see <a class="hw-link" href="http://127.0.0.1:4329/x">http://127.0.0.1:4329/x</a>.',
    },
    {
      label: "quoted URLs stop before closing quotes",
      input: `see "https://d.example/a" or 'https://d.example/b'`,
      expected:
        'see &quot;<a class="hw-link" href="https://d.example/a">https://d.example/a</a>&quot; or &#x27;<a class="hw-link" href="https://d.example/b">https://d.example/b</a>&#x27;',
    },
  ])("inline formats $label", ({ input, expected }) => {
    expect(inline(input)).toBe(expected);
  });

  test("withLinks leaves URLs already linked, inside tags, or inside code untouched", () => {
    const html =
      '<p><a href="http://a.example/">http://a.example/</a> <img src="http://b.example/i.png"> <code>curl http://c.example/y</code></p>';
    expect(withLinks(html)).toBe(html);
  });
});
