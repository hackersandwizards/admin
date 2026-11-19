import { join } from "node:path";
import { Window, type Element as DomEl, type Node as DomNode } from "happy-dom";
import { describe, expect, test } from "vitest";
import { tableScroll as brandTableScroll } from "@hackersandwizards/brand/elements/table.ts";
import {
  compareItems,
  DUE_SOON_DAYS,
  dueSoon,
  itemDefects,
  parseItem,
  usable,
  type Item,
} from "../src/items.ts";
import { readItems, renderMarkdown, treeSource } from "../src/repo.ts";
import { dueOf, inline, withLinks } from "../site/src/data.ts";

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

describe("item files", () => {
  test("within a priority order ranks, and a due date leads only within a week", () => {
    const day = 864e5;
    const at = (n: number) => new Date(Date.now() + n * day).toISOString().slice(0, 10);
    const ranked = { ...valid, id: "ranked", order: 10 };
    const far = { ...valid, id: "far", order: 20, due: at(30) };
    const near = { ...valid, id: "near", order: 30, due: at(DUE_SOON_DAYS - 1) };
    const late = { ...valid, id: "late", order: 40, due: at(-2) };
    expect([near, far, ranked, late].sort(compareItems).map((i) => i.id)).toEqual([
      "late",
      "near",
      "ranked",
      "far",
    ]);
    // Below a near due date, a question comes before work, whatever its order.
    const task = { ...valid, id: "task", kind: "work" as const, order: 1 };
    const soonTask = { ...task, id: "soon-task", due: at(1) };
    expect([task, far, soonTask, ranked].sort(compareItems).map((i) => i.id)).toEqual([
      "soon-task",
      "ranked",
      "far",
      "task",
    ]);
    // An order that is no number is its item's defect and ranks as none, never every row's sort.
    const odd = usable({ ...valid, id: "odd", order: "soon" as never });
    expect([odd, far, ranked].sort(compareItems).map((i) => i.id)).toEqual([
      "ranked",
      "far",
      "odd",
    ]);
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

  test("parse reads front matter, title and body", () => {
    const text =
      "---\nkind: decision\nstatus: open\npriority: 2\nowner: Alex\nrecommended: a\noptions:\n  - key: a\n    label: A\n  - key: b\n    label: B\n---\n\n# A question?\n\nContext.\n";
    expect(parseItem(valid.id, text)).toEqual(valid);
  });

  test("a valid item has no defects", () => {
    expect(itemDefects(valid, exists)).toEqual([]);
  });

  test.each([
    [{ priority: 4 }, "priority 4"],
    [{ kind: "task" }, "kind task"],
    [{ status: "done" }, "status done"],
    [{ owner: undefined }, "lacks owner"],
    [{ recommended: "z" }, "recommended z is not an option"],
    [{ options: [{ key: "a", label: "A" }] }, "fewer than two options"],
    [{ status: "decided" }, "decided without decision or by"],
    [{ status: "assumed", recommended: undefined }, "assumed without"],
    [{ due: "3 Nov" }, "not ISO"],
    [{ id: "Bad_Id" }, "not lower-case kebab"],
    [{ kind: "work", status: "assumed" }, "work is assumed"],
    [{ kind: "goal", priority: 2 }, "goal has a priority"],
    [{ images: { z: "x.jpg" } }, "image key z is not an option"],
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

  test("several recommended options and item images pass on a multiple item", () => {
    const item = { ...valid, multiple: true, recommended: ["a", "b"], images: ["one.jpg"] };
    expect(itemDefects(item, exists)).toEqual([]);
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

  test("parse rejects an unknown field and a missing title", () => {
    expect(() => parseItem("x", "---\nkind: review\ncolour: red\n---\n\n# T\n")).toThrow(
      "unknown field colour",
    );
    expect(() => parseItem("x", "---\nkind: review\n---\n\nNo title.\n")).toThrow("# <title>");
  });

  test("a repeated top-level field is a defect naming the file and the field", () => {
    const { defects } = readItems({
      paths: ["docs/agent-work/items/twice.md"],
      read: () =>
        '---\nkind: work\nstatus: open\n"priority": 2\nowner: Alex\noptions:\n  - key: a\n    label: A\n  - key: b\n    label: B\npriority: 3\n---\n# Twice\n',
    });
    expect(defects).toEqual(["docs/agent-work/items/twice.md: repeated field priority"]);
  });
});

describe("admin-check", () => {
  test("the spoke fixture is clean", () => {
    const { items, defects } = readItems(treeSource(join(FIX, "spoke")));
    expect(defects).toEqual([]);
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
