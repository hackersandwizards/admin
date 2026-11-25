import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Window, type Element as DomEl, type Node as DomNode } from "happy-dom";
import { describe, expect, test, vi } from "vitest";
import { tableScroll as brandTableScroll } from "@hackersandwizards/brand/elements/table.ts";
import { needsGraph, needsGraphItems, siteData } from "../src/build.ts";
import * as diagrams from "../src/repo.ts";
import {
  compareItems,
  DUE_SOON_DAYS,
  dueSoon,
  imagesOf,
  ItemError,
  itemDefects,
  parseItem,
  usable,
  type Item,
} from "../src/items.ts";
import {
  gitEnv,
  readItems,
  readRepo,
  renderMarkdown,
  thumbnail,
  treeSource,
  when,
} from "../src/repo.ts";
import { dueOf, inline, prerequisiteLabels, withLinks } from "../site/src/data.ts";
import { commit, fromFiles, repoFrom, sh } from "./admin-fixtures.ts";

const FIX = join(import.meta.dirname, "fixtures");
// Runs a check in another time zone, then restores the process's own, unset included.
const inZone = (zone: string, check: () => void) => {
  const tz = process.env.TZ;
  process.env.TZ = zone;
  try {
    check();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
};

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
    return siteData([await readRepo(dir, treeSource(dir))]).repos[0]!;
  };
  const graphDocument = (html: string | undefined) => {
    const doc = new Window().document;
    doc.body.innerHTML = html!.replace(/<style>[\s\S]*?<\/style>/g, "");
    return doc;
  };

  test("the fixture draws every needs edge and distinguishes ready, waiting, and settled items", async () => {
    const { items, needsSvg } = await fixture();
    const graph = graphDocument(needsSvg);
    const connected = needsGraphItems(items);
    const idOf = (nodeId: string) => connected[Number(nodeId.slice(1))]!.id;
    const nodes = [...graph.querySelectorAll(".node")].map((node) => {
      const rect = node.querySelector("rect")!;
      return {
        id: idOf(node.getAttribute("data-id")!),
        shape: node.getAttribute("data-shape"),
        ratio: Number(rect.getAttribute("rx")) / (Number(rect.getAttribute("height")) / 2),
      };
    });
    expect(nodes).toEqual([
      { id: "pick-a-variant", shape: "stadium", ratio: 1 },
      { id: "work-wire-the-gate", shape: "rectangle", ratio: 0 },
      { id: "check-the-copy", shape: "rectangle", ratio: 0 },
      { id: "name-the-command", shape: "rounded", ratio: expect.any(Number) },
      { id: "cache-folder", shape: "rounded", ratio: expect.any(Number) },
      { id: "goal", shape: "stadium", ratio: 1 },
    ]);
    const roundedRatios = [nodes[3]!.ratio, nodes[4]!.ratio];
    expect(Math.min(...roundedRatios)).toBeGreaterThan(0);
    expect(Math.max(...roundedRatios)).toBeLessThan(1);
    const edges = [...graph.querySelectorAll(".edge")].map((edge) => ({
      from: idOf(edge.getAttribute("data-from")!),
      to: idOf(edge.getAttribute("data-to")!),
      style: edge.getAttribute("data-style"),
      dashed: edge.hasAttribute("stroke-dasharray"),
    }));
    expect(edges).toEqual([
      { from: "check-the-copy", to: "work-wire-the-gate", style: "solid", dashed: false },
      { from: "cache-folder", to: "work-wire-the-gate", style: "dotted", dashed: true },
      { from: "name-the-command", to: "work-wire-the-gate", style: "dotted", dashed: true },
      { from: "pick-a-variant", to: "check-the-copy", style: "solid", dashed: false },
      { from: "goal", to: "name-the-command", style: "solid", dashed: false },
      { from: "pick-a-variant", to: "cache-folder", style: "solid", dashed: false },
    ]);
  });

  test("the prerequisite stands on the left in the Mermaid source and the SVG", async () => {
    const { items } = await fixture();
    const wire = items.find((item) => item.id === "work-wire-the-gate")!;
    const check = items.find((item) => item.id === "check-the-copy")!;
    const render = vi.spyOn(diagrams, "diagram");
    try {
      const graph = graphDocument(needsGraph([wire, check]));
      expect(graph.querySelectorAll(".edge")).toHaveLength(1);
      const x = (id: string) =>
        Number(graph.querySelector(`[data-id="${id}"] rect`)!.getAttribute("x"));
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
      { ...items[0]!, id: "try--this", title, status: "open" as const, waitingOn: [], needs: [] },
      {
        ...items[1]!,
        title,
        status: "open" as const,
        waitingOn: ["try--this"],
        needs: ["try--this"],
      },
      { ...items[2]!, title, status: "decided" as const, needs: [] },
    ];
    const graph = graphDocument(needsGraph(input));
    expect(graph.querySelectorAll(".node")).toHaveLength(input.length);
    expect(graph.querySelectorAll(".edge")).toHaveLength(1);
    expect(graph.querySelector('.edge[data-from="n0"][data-to="n1"]')).toBeTruthy();
    const nodes = [...graph.querySelectorAll(".node")];
    expect(nodes.map((node) => node.getAttribute("data-shape"))).toEqual([
      "stadium",
      "rectangle",
      "rounded",
    ]);
    expect(nodes.map((node) => node.getAttribute("data-label"))).toEqual(input.map(() => title));
    expect(nodes.map((node) => node.querySelector("text")?.textContent)).toEqual(
      input.map(() => title),
    );
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
    const graph = graphDocument(siteData([repo]).repos[0]!.needsSvg);
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
    const graph = graphDocument(siteData([repo]).repos[0]!.needsSvg);
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
      expect(render).toHaveBeenCalledTimes(2);
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
        new ItemError('body does not start with "# <title>"'),
      );
    },
  );

  test("a valid item has no defects", () => {
    expect(itemDefects(valid, exists)).toEqual([]);
  });

  test.each([
    [{ priority: 4 }, "priority 4"],
    [{ kind: "task" }, "kind task"],
    [{ status: "done" }, "status done"],
    [{ owner: undefined }, "lacks owner"],
    [{ options: [{ key: "a", label: "A" }] }, "fewer than two options"],
    [{ status: "decided" }, "decided without decision or by"],
    [{ status: "assumed", recommended: undefined }, "assumed without"],
    [{ due: "3 Nov" }, "not ISO"],
    [{ id: "Bad_Id" }, "not lower-case kebab"],
    [{ kind: "work", status: "assumed" }, "work is assumed"],
    [{ kind: "goal", priority: 2 }, "goal has a priority"],
    [{ recommended: ["a", "b"] }, "several recommended without multiple"],
    [{ multiple: "yes" }, "multiple yes is not true or false"],
    [
      {
        options: [
          { key: "a", label: "A", score: "8" },
          { key: "b", label: "B" },
        ],
      },
      "score 8",
    ],
    [
      {
        options: [
          { key: "a", label: "A", noise: 1 },
          { key: "b", label: "B" },
        ],
      },
      "noise without",
    ],
    [{ images: [{ src: "x.jpg", alt: "x" }] }, "is not a path or {src, caption}"],
    [{ images: { a: [{ caption: "no src" }] } }, "is not a path or {src, caption}"],
  ] as [Partial<Item>, string][])("defect %#: %o", (change, message) => {
    const defects = itemDefects({ ...valid, ...change } as Item, exists);
    expect(defects.join("\n")).toContain(message);
  });

  test("a missing image is a defect; a bare name lies in the item's own folder", () => {
    const item = { ...valid, images: { a: "docs/x.jpg", b: [{ src: "y.jpg", caption: "dark" }] } };
    expect(itemDefects(item, () => false)).toEqual([
      "image docs/x.jpg not found",
      "image docs/agent-work/items/a-question/y.jpg not found",
    ]);
  });

  test("an item without page: the field is gone", () => {
    expect(() =>
      parseItem("x", "---\nkind: review\npage: docs/p/index.html\n---\n\n# T\n"),
    ).toThrow("unknown field page");
  });

  test("a field the pages print as text, a day and an option key are checked as such", () => {
    const defects = (more: object) => itemDefects({ ...valid, ...more } as Item, exists);
    expect(defects({ due: "2026-13-45" })).toContain("due 2026-13-45 not ISO");
    expect(defects({ due: "2028-02-29" })).toEqual([]);
    expect(defects({ area: { a: 1 } })).toEqual(["area is not text"]);
    expect(defects({ area: "Field Ops" })).toEqual([]);
    const options = (a: object) => ({
      options: [
        { key: "a", label: "A", ...a },
        { key: "b", label: "B" },
      ],
    });
    expect(defects(options({ label: { l: 1 } }))).toContain("option a label or detail is not text");
    expect(defects({ ...options({ key: "a,b" }), recommended: "b" })).toContain(
      'option 1 key "a,b" is not one word',
    );
    // A numeric key is the key an images mapping names, 0 included.
    const numbered = {
      options: [
        { key: 0, label: "Zero" },
        { key: 1, label: "One" },
      ],
      recommended: 1,
    };
    expect(defects({ ...numbered, images: { 0: "a.png", 1: "b.png" } })).toEqual([]);
    const shown = usable({
      ...valid,
      ...numbered,
      area: { a: 1 },
      due: "2026-13-45",
    } as unknown as Item);
    expect([shown.area, shown.due, shown.options!.map((o) => o.key), shown.recommended]).toEqual([
      undefined,
      undefined,
      ["0", "1"],
      ["1"],
    ]);
    // An image names a file: a folder of that name is no image.
    const { defects: found } = readItems({
      paths: ["docs/agent-work/items/shot.md", "docs/agent-work/2026-01-01-r/a.png"],
      read: () =>
        "---\nkind: review\nstatus: open\npriority: 2\nowner: Alex\nimages: [docs/agent-work/2026-01-01-r]\n---\n# Shot\n",
    });
    expect(found).toEqual([
      "docs/agent-work/items/shot.md: image docs/agent-work/2026-01-01-r not found",
    ]);
  });

  test("a repeated top-level field is a defect naming the file and the field", () => {
    const { defects } = readItems({
      paths: ["docs/agent-work/items/twice.md"],
      read: () =>
        '---\nkind: work\nstatus: open\n"priority": 2\nowner: Alex\noptions:\n  - key: a\n    label: A\n  - key: b\n    label: B\npriority: 3\n---\n# Twice\n',
    });
    expect(defects).toEqual(["docs/agent-work/items/twice.md: repeated field priority"]);
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
    ["An introduction\n---\nkind: work\n---\n# Move", "no frontmatter"],
    ["---\n[work, open]\n---\n# Move", "frontmatter is not a mapping"],
    ["---\nwork\n---\n# Move", "frontmatter is not a mapping"],
    ["---\n[unfinished\n---\n# Move", "frontmatter:"],
    ["---\nkind: work\n---\nIntro first.\n# Move", 'body does not start with "# <title>"'],
    ["---\ncolour: red\nsize: big\n---\n# Move", "unknown field colour, size"],
    ["---\nkind: work\nkind : review\n---\n# Move", "repeated field kind"],
  ])("reports the defect in an item file (%#)", (text, message) => {
    expect(() => parseItem("move", text)).toThrow(message);
  });

  test.each([
    [{ order: "first" }, "order first"],
    [{ options: "" }, "options is not a list"],
    [{ options: [null, { key: "b", label: "B" }] }, "option 1 lacks key or label"],
    [
      {
        options: [
          { key: "a", label: "" },
          { key: "b", label: "B" },
        ],
      },
      "option 1 lacks key or label",
    ],
    [
      {
        options: [
          { key: "a", label: "A" },
          { key: null, label: "B" },
        ],
      },
      "option 2 lacks key or label",
    ],
    [
      {
        options: [
          { key: "a", label: "A", detail: ["notes"] },
          { key: "b", label: "B" },
        ],
      },
      "option a label or detail is not text",
    ],
    [
      {
        options: [
          { key: "a", label: "A", score: 8, noise: "small" },
          { key: "b", label: "B" },
        ],
      },
      "option a noise without a numeric score",
    ],
    [{ status: "decided", decision: "Use A" }, "decided without decision or by"],
    [{ status: "decided", by: "Alex" }, "decided without decision or by"],
    [{ images: "one.png" }, "images is neither a list nor a mapping"],
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
  const render = (text: string) => renderMarkdown("/r", "docs/a.md", text);

  test("renders inline SVG without remote fonts", () => {
    const html = render(flow);
    expect(html).toContain('<figure class="admin-diagram not-prose" tabindex="0"><svg');
    expect(html).toContain('data-to="b"');
    expect(html).not.toMatch(/@import|googleapis|font-family|<pre/);
  });

  test("diagrams share no id within or across documents", () => {
    const text = flow + "\n" + flow;
    const first = render(text);
    const others = [render("# Other document\n\n" + flow), renderMarkdown("/r", "docs/b.md", flow)];
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
    const ids = siteData([repo]).repos[0]!.items.map(
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
    const html = withLinks(siteData([repo]).repos[0]!.items[0]!.html);
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
    const ids = (item: boolean) =>
      [...renderMarkdown("/r", "docs/a.md", text, item).matchAll(/id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids(false)).toEqual(["section-copy", "same", "same-1", "same-1-1"]);
    expect(ids(true)).toEqual([]);
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
    expect(items.map((i) => i.id).sort()).toEqual([
      "ask-the-printer",
      "cache-folder",
      "check-the-copy",
      "goal",
      "name-the-command",
      "pick-a-logo",
      "pick-a-variant",
      "pick-recipients",
      "sort-the-samples",
      "work-wire-the-gate",
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
      for (const item of [false, true])
        expect(renderMarkdown("/r", "docs/a.md", md, item)).not.toContain("<a ");
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
      expect(renderMarkdown("/r", "docs/a.md", raw)).not.toMatch(
        /href\s*=\s*(?!["']?\s*https:)|javascript/i,
      );
    const ok = renderMarkdown(
      "/r",
      "docs/a.md",
      "[h](https://a.test/) [i](HTTP://a.test/) [m](mailto:x@a.test) [p](b.md#t) [q](/b.md) [s](#t) [a](q&a.md) [t](10:30.md)",
    );
    expect(ok.match(/<a /g)).toHaveLength(8);
    expect(ok).toContain('href="file:///r/docs/b.md#t"');
  });

  test("a stray % in a Markdown link stays as written", () => {
    expect(renderMarkdown("/r", "docs/a.md", "[half](50%.md)")).toContain("docs/50%25.md");
  });

  test("a task list wears no marker beside its read-only hw-check boxes", () => {
    const html = renderMarkdown("/r", "docs/a.md", "- [ ] open\n- [x] done\n\nNext:\n\n- plain\n");
    expect(html.match(/hw-marker-list/g)).toHaveLength(1);
    expect(html).toContain('<ul>\n<li class="task-list-item">');
    expect(
      html.match(/class="task-list-item-checkbox hw-check" data-readonly disabled/g),
    ).toHaveLength(2);
  });

  test("each task box is named by its own line, tight, nested or loose", () => {
    const box = '<input type="checkbox" class="task-list-item-checkbox hw-check" data-readonly';
    const tight = renderMarkdown("/r", "docs/a.md", "- [x] done **now**\n  - [ ] nested\n");
    expect(tight).toContain(
      `<label>${box} disabled checked>done <strong>now</strong></label>\n<ul>`,
    );
    expect(tight).toContain(`<label>${box} disabled>nested</label></li>`);
    const loose = renderMarkdown("/r", "docs/a.md", "- [ ] loose\n\n  more\n\n- [x] next\n");
    expect(loose).toContain(`<p><label>${box} disabled>loose</label></p>\n<p>more</p>`);
    const quote = renderMarkdown("/r", "docs/a.md", "- [ ] see\n  > quoted\n");
    expect(quote).toContain(`<label>${box} disabled>see</label>\n<blockquote`);
    const wrapped = renderMarkdown("/r", "docs/a.md", "- [ ] a [link\n  **b**](x.md) end\n");
    expect(wrapped).toContain("</strong></a> end</label>");
    const fence = renderMarkdown("/r", "docs/a.md", "- [ ] run\n  ```\n  x\n  ```\n");
    expect(fence).toContain(`<label>${box} disabled>run</label>\n<pre`);
    const mermaid = renderMarkdown(
      "/r",
      "docs/a.md",
      "- [ ] check diagram\n  ```mermaid\n  flowchart LR\n    a --> b\n  ```\n",
    );
    expect(mermaid).toContain(`<label>${box} disabled>check diagram</label>\n<figure`);
  });
});

describe("hub", () => {
  test("front matter is a leading YAML mapping; a leading rule stays in the doc", () => {
    const html = (text: string) => renderMarkdown("/r", "docs/a.md", text);
    expect(html("---\n\nintro\n\n---\n\nrest\n")).toContain("intro");
    expect(html("---\ntitle: x\n---\n\nrest\n")).not.toContain("title");
  });

  test("a table's wrapper is named as brand's tableScroll names it", () => {
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
    const hast = (n: DomNode): Hast => {
      if (n.nodeType === 3) return { type: "text", value: n.textContent ?? "" };
      if (n.nodeType !== 1) return { type: "comment" };
      const el = n as DomEl;
      const children = [...el.childNodes].map(hast);
      return {
        type: "element",
        tagName: el.localName,
        properties: { className: [...el.classList] },
        children,
      };
    };
    const wrappers = (n: Hast): Hast[] => [
      ...([n.properties?.className].flat().includes("hw-table-scroll") ? [n] : []),
      ...(n.children ?? []).flatMap(wrappers),
    ];
    const table = (head: string) => `| ${head} | B |\n| - | - |\n| 1 | 2 |\n\n`;
    const text = `${table("A **b**")}${table("A b")}## Prices\n\n${table("x")}${table("y")}<H3>Raw "q" &amp; <i>it</i></H3>\n\n${table("z")}# Next\n\n| |\n|-|\n|1|\n\n## Prices\n\n${table("w")}`;
    const ours = [
      ...dom(renderMarkdown("/r", "docs/a.md", text)).querySelectorAll(".hw-table-scroll"),
    ].map((w) => w.getAttribute("aria-label"));
    const root: Hast = {
      type: "root",
      children: [...dom(Bun.markdown.html(text)).childNodes].map(hast),
    };
    brandTableScroll()(root);
    expect(ours).toEqual(
      wrappers(root).map((w) => (w.properties!.ariaLabel as string | undefined) ?? null),
    );
    expect(ours).toEqual([
      "A b B",
      "A b B (2)",
      "Prices",
      "Prices (2)",
      'Raw "q" & it',
      "Next",
      "Prices (3)",
    ]);
    expect(
      [
        ...dom(renderMarkdown("/r", "docs/a.md", "| |\n|-|\n|1|\n")).querySelectorAll(
          ".hw-table-scroll",
        ),
      ].map((w) => w.getAttribute("aria-label")),
    ).toEqual([null]);
  });

  test("a table holding another leaves the wrapper to the inner one", () => {
    const html = renderMarkdown(
      "/r",
      "docs/a.md",
      "<table><tr><td><table><tr><td>in</td></tr></table></td><td>x</td></tr></table>\n",
    );
    expect(html).toContain('<td><div class="hw-table-scroll"');
    expect(html).toContain("</table></div></td>");
    // A raw table keeps its own attributes.
    expect(
      renderMarkdown("/r", "docs/a.md", '<table class="x"><tr><td>a</td></tr></table>\n'),
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

  test("committed history and the working tree show the files each reader promises", async () => {
    const generated = join(import.meta.dirname, "../node_modules/.cache");
    mkdirSync(generated, { recursive: true });
    const repo = mkdtempSync(join(generated, "admin-repo-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: repo,
        env: {
          ...gitEnv,
          GIT_AUTHOR_DATE: "2026-01-14T12:34:00Z",
          GIT_COMMITTER_DATE: "2026-01-14T12:34:00Z",
        },
      });
      if (result.exitCode) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git("init", "-q");
      const work = "docs/agent-work/items/ship.md";
      const report = "docs/agent-work/2026-01-14-first draft.md";
      const reportText = "# First draft\n";
      await Bun.write(join(repo, report), reportText);
      await Bun.write(
        join(repo, work),
        "---\nkind: work\nstatus: open\npriority: 1\nowner: Alex\n---\n# Ship the samples",
      );
      await Bun.write(join(repo, ".gitignore"), "ignored.txt\n");
      await Bun.write(join(repo, "docs/note.md"), "# First note\n\nCafé");
      await Bun.write(join(repo, "docs/next.md"), "# Next note\n\nTwo");
      await Bun.write(join(repo, "package.json"), '{"name":"paint","version":"1.0.0"}');
      git("add", "--", ".gitignore", "docs", "package.json");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "Write notes",
      );
      const fetch = join(repo, ".git/FETCH_HEAD");
      await Bun.write(fetch, "");
      const fetched = new Date("2026-01-15T10:00:00Z");
      utimesSync(fetch, fetched, fetched);
      await Bun.write(join(repo, "docs/note.md"), "# Edited note\n\nDraft");
      await Bun.write(join(repo, "ignored.txt"), "Generated");
      await Bun.write(join(repo, "docs/draft.md"), "# Draft");
      rmSync(join(repo, "docs/next.md"));

      const tree = treeSource(repo);
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

      const committed = await readRepo(repo);
      const time = Date.parse("2026-01-14T12:34:00Z") / 1000;
      expect(committed.fetched).toBe(fetched.getTime());
      expect(committed.behind).toBeUndefined();
      expect(committed.head).toMatch(/^[a-f0-9]{7,}$/);
      expect(committed.log).toEqual([{ hash: committed.head, time, subject: "Write notes" }]);
      expect(committed.trackingLog).toEqual(committed.log);
      expect(committed.reports).toMatchObject([
        { path: report, changed: time, version: Bun.hash(reportText).toString(36) },
      ]);
      expect(committed.items).toMatchObject([
        { id: "ship", title: "Ship the samples", changed: time },
      ]);
      expect(committed.docs).toEqual([
        { path: "docs/next.md", title: "Next note", titleId: "next-note", html: "<p>Two</p>\n" },
        { path: "docs/note.md", title: "First note", titleId: "first-note", html: "<p>Café</p>\n" },
      ]);
      expect(committed.pkg).toMatchObject({ name: "paint", version: "1.0.0" });
      expect(committed.defects).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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

  test("a repository publishes its configured links, checks, scripts and review material", async () => {
    const report = "docs/agent-work/2026-01-14-paint";
    const repo = await readFiles({
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
      "docs/guide.md": "# Tool &amp; *guide*\n\nInstructions",
      "README.md": "# Read me\n\nStart",
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
    expect(repo).toMatchObject({
      key: "paint.samples",
      label: "Paint samples",
      pkg: {
        name: "paint",
        version: "2.0.0",
        dependencies: { tint: "1.0.0", sampler: "2.0.0" },
        bin: { paint: "./scripts/paint.ts" },
      },
      designSystem: "https://paint.example/catalog/",
      designSystemDev: undefined,
      checkSteps: ["format", "test"],
      agents: ["Mira"],
    });
    expect(repo.defects).toEqual(["docs/agent-work/admin.json: ignored, package.json holds admin"]);
    expect(repo.products).toEqual([
      {
        label: "Tiles",
        description: "Browse the colors",
        href: "file:///nonexistent/paint%20samples/docs/tiles.html",
      },
    ]);
    expect(repo.links).toEqual([
      { label: "Guide", href: "file:///nonexistent/paint%20samples/docs/guide.md?print=1#start" },
    ]);
    expect(repo.scripts).toEqual([
      { path: "scripts/paint.ts", comment: "Render color samples" },
      { path: "scripts/other.sh", comment: "Export samples" },
    ]);
    expect(repo.docs).toEqual([
      {
        path: "docs/guide.md",
        title: "Tool & guide",
        titleId: "tool-guide",
        html: "<p>Instructions</p>\n",
      },
      { path: "README.md", title: "Read me", titleId: "read-me", html: "<p>Start</p>\n" },
    ]);
    expect(repo.reports).toEqual([
      {
        path: "docs/agent-work/2026-01-15-next.md",
        stem: "2026-01-15-next",
        date: "2026-01-15",
        title: "2026-01-15-next",
        changed: undefined,
        version: Bun.hash("Planning").toString(36),
        html: "<p>Planning</p>\n",
      },
      {
        path: `${report}.md`,
        date: "2026-01-14",
        title: "Sample review",
        titleId: "sample-review",
        stem: "2026-01-14-paint",
        changed: undefined,
        version: Bun.hash("# Sample review\n\nComparison").toString(36),
        html: "<p>Comparison</p>\n",
      },
    ]);
    expect(repo.reviews).toEqual([
      {
        dir: "docs/agent-work/2026-01-15-next",
        images: ["first.jpg"],
        report: "docs/agent-work/2026-01-15-next.md",
      },
      { dir: report, images: ["a.webp", "z.PNG"], report: `${report}.md` },
    ]);
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
    const html = renderMarkdown(
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
    const html = renderMarkdown(
      "/r",
      "docs/x.md",
      `<p>href="x?&#60;a href=javascript:alert(1)&#62;c&#60;/a&#62;"</p>\n\n` +
        `<img alt='src="y?&#39; onerror=alert(1) x=&#39;"' src=z.png>`,
    );
    expect(html).not.toMatch(/<a |' onerror/);
    // A named entity in the fragment keeps the character it names.
    expect(renderMarkdown("/r", "docs/x.md", `<a href="x.md#a&quot;b">r</a>`)).toContain(
      'href="file:///r/docs/x.md#a&quot;b"',
    );
    // An address or a fragment behind a leading space stays as written, as a browser reads it.
    const lead = renderMarkdown(
      "/r",
      "docs/x.md",
      `<a href="&#32;https://a.test/">a</a><a href="&#9;#t">t</a>`,
    );
    expect(lead).toContain('href="&#32;https://a.test/"');
    expect(lead).toContain('href="&#9;#t"');
    // A browser reads &AMP;, &LT;, &GT; and &QUOT; as their lower-case names, and &Amp; or &APOS;
    // as text.
    const upper = renderMarkdown(
      "/r",
      "docs/x.md",
      `<a href="q&AMP;a.md">q</a><img src="x&Amp;y.png"><a href="b&APOS;c.md">b</a>`,
    );
    expect(upper).toContain('href="file:///r/docs/q%26a.md"');
    expect(upper).toContain('src="file:///r/docs/x%26Amp;y.png"');
    expect(upper).toContain(">b</p>");
    expect(upper).not.toContain("APOS");
  });

  test("a due date says today or overdue, and a one-line field renders its code and links", () => {
    const now = new Date(2026, 10, 10, 12).getTime();
    expect(dueOf("2026-11-10", now)).toEqual({ text: "due today", tone: "today" });
    expect(dueOf("2026-11-03", now).tone).toBe("overdue");
    expect(dueOf("2026-11-03", now).text.startsWith("was due 3 Nov")).toBe(true);
    expect(dueOf("2026-11-13", now).tone).toBe("soon");
    expect(dueOf("2026-12-13", now).tone).toBe("later");
    // A day more than 300 days away names its year, ahead as behind.
    expect(dueOf("2027-12-01", now).text).toBe("due 1 Dec 2027");
    // West of UTC too, the pill names the day written.
    inZone("America/New_York", () =>
      expect(dueOf("2026-11-20", new Date(2026, 10, 10, 12).getTime()).text).toBe("due 20 Nov"),
    );
    expect(inline("use `a-b` & <i>, see http://127.0.0.1:4329/x.")).toBe(
      'use <code class="hw-inline-code">a-b</code> &amp; &lt;i&gt;, see <a class="hw-link" href="http://127.0.0.1:4329/x">http://127.0.0.1:4329/x</a>.',
    );
    // An address already linked, inside a tag or inside code stays as it is; quotes end one.
    const html =
      '<p><a href="http://a.example/">http://a.example/</a> <img src="http://b.example/i.png"> <code>curl http://c.example/y</code></p>';
    expect(withLinks(html)).toBe(html);
    expect(inline(`see "https://d.example/a" or 'https://d.example/b'`)).toBe(
      'see &quot;<a class="hw-link" href="https://d.example/a">https://d.example/a</a>&quot; or &#x27;<a class="hw-link" href="https://d.example/b">https://d.example/b</a>&#x27;',
    );
  });
});
