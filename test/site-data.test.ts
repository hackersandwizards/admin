import { assert, describe, expect, test, vi } from "vitest";
import * as diagrams from "../src/diagrams.ts";
import type { Item } from "../src/items.ts";
import * as markdown from "../src/markdown.ts";
import type { RepoData } from "../src/repo.ts";
import {
  createItemHtmlRenderer,
  createOwnerClassifier,
  firstWord,
  repoPages,
  repoViewItems,
  siteData,
  summarizeOwners,
  type SiteData,
} from "../src/site-data.ts";

const makeItem = (overrides: Partial<Item> & { id: string }): Item => ({
  kind: "work",
  status: "open",
  priority: 2,
  owner: "Kira",
  title: overrides.id,
  body: "",
  ...overrides,
});

const makeRepo = (overrides: Partial<RepoData> = {}): RepoData => ({
  key: "demo",
  path: "/r/demo",
  label: "Demo",
  head: "abc123",
  items: [],
  reports: [],
  reviews: [],
  docs: [],
  workFiles: [],
  scripts: [],
  agents: [],
  products: [],
  links: [],
  checkSteps: [],
  defects: [],
  trackingLog: [],
  log: [],
  pkg: { dependencies: {}, scripts: {}, bin: {} },
  ...overrides,
});

describe("firstWord", () => {
  test.each([
    ["simple name", "Kira", "Kira"],
    ["hyphenated name", "Mina-Jo", "Mina-Jo"],
    ["leading word before spaces", "an agent", "an"],
    ["stops before plus joiner", "B+L", "B"],
    ["stops before punctuation", "Nora.", "Nora"],
    ["returns original string when no leading word matches", "(tbd)", "(tbd)"],
    ["defaults undefined to empty string", undefined, ""],
  ])("%s", (_label, input, expected) => {
    expect(firstWord(input)).toBe(expected);
  });
});

describe("createItemHtmlRenderer", () => {
  const alpha = makeRepo({
    key: "alpha",
    path: "/r/alpha",
    workFiles: ["docs/agent-work/own.md", "docs/agent-work/übung.md"],
  });
  const beta = makeRepo({
    key: "beta",
    path: "/r/beta",
    workFiles: ["docs/agent-work/shared.md"],
  });
  const render = createItemHtmlRenderer([alpha, beta]);

  test.each([
    {
      label: "links an existing path in the item's own repository",
      body: "See docs/agent-work/own.md.",
      expected:
        '<p>See <a class="hw-link" href="file:///r/alpha/docs/agent-work/own.md">docs/agent-work/own.md</a>.</p>\n',
    },
    {
      label: "leaves a missing path as plain text",
      body: "See docs/agent-work/absent.md.",
      expected: "<p>See docs/agent-work/absent.md.</p>\n",
    },
    {
      label: "links into a repository named immediately before the path",
      body: "beta `docs/agent-work/shared.md`",
      expected:
        '<p>beta <code class="hw-inline-code"><a class="hw-link" href="file:///r/beta/docs/agent-work/shared.md">docs/agent-work/shared.md</a></code></p>\n',
    },
    {
      label: "links into a repository named after the path with in",
      body: "`docs/agent-work/shared.md` in beta",
      expected:
        '<p><code class="hw-inline-code"><a class="hw-link" href="file:///r/beta/docs/agent-work/shared.md">docs/agent-work/shared.md</a></code> in beta</p>\n',
    },
    {
      label: "falls back to the item's own repository when the adjacent name is unknown",
      body: "ghost `docs/agent-work/own.md`",
      expected:
        '<p>ghost <code class="hw-inline-code"><a class="hw-link" href="file:///r/alpha/docs/agent-work/own.md">docs/agent-work/own.md</a></code></p>\n',
    },
    {
      label: "percent-encodes non-ASCII paths in href while keeping label text",
      body: "docs/agent-work/übung.md",
      expected:
        '<p><a class="hw-link" href="file:///r/alpha/docs/agent-work/%C3%BCbung.md">docs/agent-work/übung.md</a></p>\n',
    },
    {
      label: "does not nest a link inside an existing anchor",
      body: "[docs/agent-work/own.md](https://example.invalid/)",
      expected:
        '<p><a class="hw-link" href="https://example.invalid/">docs/agent-work/own.md</a></p>\n',
    },
  ])("$label", ({ body, expected }) => {
    expect(render(alpha, makeItem({ id: "sample", body }))).toBe(expected);
  });
});

describe("createOwnerClassifier", () => {
  const classify = createOwnerClassifier(
    [
      makeRepo({
        agents: ["Nova"],
        items: [
          makeItem({ id: "i1", owner: "Kira" }),
          makeItem({ id: "i2", owner: "Mina" }),
          makeItem({ id: "i3", owner: "Mina-Jo" }),
          makeItem({ id: "i4", owner: "C&D" }),
          makeItem({ id: "i5", owner: "mBot Labs" }),
        ],
      }),
    ],
    "Taro",
  );

  test.each([
    [
      "picks the first named person by position",
      "Nova drafts, Mina reviews, Kira ships",
      { who: "Mina", as: "person" },
    ],
    [
      "recognizes the hub user even without an opening item",
      "Nova drafts, Taro ships",
      { who: "Taro", as: "person" },
    ],
    [
      "matches whole names so Mina does not match Mina-Jo",
      "Mina-Jo",
      { who: "Mina-Jo", as: "person" },
    ],
    ["classifies runtime name as agent", "Codex", { who: "Codex", as: "agent" }],
    ["classifies article-led owner as agent", "A bot", { who: "A", as: "agent" }],
    ["classifies repo-defined agent as agent", "Nova", { who: "Nova", as: "agent" }],
    ["classifies parenthetical owner as agent", "(pending)", { who: "(pending)", as: "agent" }],
    [
      "classifies ampersand-joined owner up to semicolon as party",
      "C&D; next sprint",
      { who: "C&D", as: "party" },
    ],
    [
      "classifies mixed-case firm up to paren as party",
      "mBot Labs (partner)",
      { who: "mBot Labs", as: "party" },
    ],
  ])("%s", (_label, owner, expected) => {
    expect(classify(owner)).toEqual(expected);
  });
});

describe("summarizeOwners", () => {
  test("orders people by hub user, open questions, total open items, then name, and lists parties in others", () => {
    const items = [
      makeItem({ id: "t1", kind: "work", owner: "Taro" }),
      makeItem({ id: "m1", kind: "decision", owner: "Mara" }),
      makeItem({ id: "m2", kind: "review", owner: "Mara" }),
      makeItem({ id: "n1", kind: "decision", owner: "Nora" }),
      makeItem({ id: "n2", kind: "work", owner: "Nora" }),
      makeItem({ id: "n3", kind: "work", owner: "Nora" }),
      makeItem({ id: "b1", kind: "decision", owner: "Bram" }),
      makeItem({ id: "b2", kind: "work", owner: "Bram" }),
      makeItem({ id: "a1", kind: "decision", owner: "Aron" }),
      makeItem({ id: "a2", kind: "work", owner: "Aron" }),
      makeItem({ id: "s1", kind: "decision", status: "decided", owner: "Settled" }),
      makeItem({ id: "p1", kind: "work", owner: "C&D" }),
      makeItem({ id: "g1", kind: "work", owner: "bot-runner" }),
    ];
    const classify = createOwnerClassifier([makeRepo({ items })], "Taro");
    expect(summarizeOwners(items, classify, "Taro")).toEqual({
      people: ["Taro", "Mara", "Nora", "Aron", "Bram"],
      others: ["Aron", "Bram", "C&D", "Mara", "Nora"],
    });
  });
});

describe("repoViewItems", () => {
  test("sorts items, resolves fallback label, option images, agent flag, and recommendation labels", () => {
    const options = [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
      { key: "c", label: "Gamma" },
      { key: "d", label: "Delta" },
    ];
    const repo = makeRepo({
      key: "sample",
      path: "/r/sample",
      label: undefined,
      items: [
        makeItem({ id: "unowned", priority: 3, owner: undefined }),
        makeItem({
          id: "few",
          kind: "decision",
          priority: 1,
          owner: "bot-runner",
          options,
          multiple: true,
          recommended: ["a", "c"],
          images: { a: ["shot.png"] },
        }),
        makeItem({
          id: "many",
          kind: "decision",
          priority: 2,
          owner: "Kira",
          options,
          multiple: true,
          recommended: ["a", "b", "c", "d"],
        }),
      ],
    });
    const classify = createOwnerClassifier([repo]);
    const out = repoViewItems(repo, classify, (_r, item) => `<p>${item.id}</p>`).map((i) => ({
      id: i.id,
      repoLabel: i.repoLabel,
      agent: i.agent,
      html: i.html,
      optionImages: i.optionImages,
      recommendedKeys: i.recommendedKeys,
      recommendedLabel: i.recommendedLabel,
    }));
    expect(out).toEqual([
      {
        id: "few",
        repoLabel: "sample",
        agent: true,
        html: "<p>few</p>",
        optionImages: {
          a: [{ src: "file:///r/sample/docs/agent-work/items/few/shot.png" }],
        },
        recommendedKeys: ["a", "c"],
        recommendedLabel: "Alpha, Gamma",
      },
      {
        id: "many",
        repoLabel: "sample",
        agent: false,
        html: "<p>many</p>",
        optionImages: { "": [] },
        recommendedKeys: ["a", "b", "c", "d"],
        recommendedLabel: "4 options",
      },
      {
        id: "unowned",
        repoLabel: "sample",
        agent: false,
        html: "<p>unowned</p>",
        optionImages: { "": [] },
        recommendedKeys: [],
        recommendedLabel: undefined,
      },
    ]);
  });
});

describe("repoPages", () => {
  const repo = makeRepo({
    designSystem: "http://127.0.0.1:4332/catalog/",
    products: [{ label: "Web", href: "https://example.invalid/" }],
    reports: [
      {
        path: "docs/agent-work/2026-01-10-decisions-only.md",
        stem: "2026-01-10-decisions-only",
        date: "2026-01-10",
        title: "Decisions Only",
        version: "1",
        html: "<p>D</p>",
      },
      {
        path: "docs/agent-work/2026-01-11-with-work.md",
        stem: "2026-01-11-with-work",
        date: "2026-01-11",
        title: "With Work",
        version: "2",
        html: "<p>W</p>",
      },
      {
        path: "docs/agent-work/2026-01-12-with-goal.md",
        stem: "2026-01-12-with-goal",
        date: "2026-01-12",
        title: "With Goal",
        version: "3",
        html: "<p>G</p>",
      },
    ],
    docs: [{ path: "README.md", title: "Readme", html: "<p>R</p>" }],
    items: [
      makeItem({ id: "d1", kind: "decision", topic: "2026-01-10-decisions-only" }),
      makeItem({ id: "w1", kind: "work", title: "Wire Work", topic: "2026-01-11-with-work" }),
      makeItem({ id: "g1", kind: "goal", title: "Ship Goal", topic: "2026-01-12-with-goal" }),
    ],
  });
  const pages = repoPages(
    repo,
    repoViewItems(repo, createOwnerClassifier([repo]), () => ""),
  );

  test("emits repository pages in order and renders topicGraph only when topic has work or goal", () => {
    expect(pages.map(({ path, type, topic }) => ({ path, type, topic }))).toEqual([
      { path: "demo/dashboard", type: "dashboard", topic: undefined },
      { path: "demo/decisions", type: "decisions", topic: undefined },
      { path: "demo/work", type: "work", topic: undefined },
      { path: "demo/reviews", type: "reviews", topic: undefined },
      { path: "demo/docs", type: "docs", topic: undefined },
      { path: "demo/catalog", type: "catalog", topic: undefined },
      { path: "demo/products-1", type: "product", topic: undefined },
      { path: "demo/architecture", type: "architecture", topic: undefined },
      { path: "demo/checks", type: "checks", topic: undefined },
      { path: "demo/log", type: "log", topic: undefined },
      { path: "demo/doc/docs/agent-work/2026-01-10-decisions-only", type: "doc", topic: true },
      { path: "demo/doc/docs/agent-work/2026-01-11-with-work", type: "doc", topic: true },
      { path: "demo/doc/docs/agent-work/2026-01-12-with-goal", type: "doc", topic: true },
      { path: "demo/doc/README", type: "doc", topic: undefined },
    ]);
    const decisionsPage = pages[10];
    const workPage = pages[11];
    const goalPage = pages[12];
    const readmePage = pages[13];
    assert(decisionsPage, "decisions topic page");
    assert(workPage, "work topic page");
    assert(goalPage, "goal topic page");
    assert(readmePage, "readme doc page");
    expect(decisionsPage.topicGraph).toBeUndefined();
    expect(workPage.topicGraph).toMatch(/^<figure[\s\S]*<svg[\s\S]*data-label="Wire Work"/);
    expect(goalPage.topicGraph).toMatch(/^<figure[\s\S]*<svg[\s\S]*data-label="Ship Goal"/);
    expect(readmePage.topicGraph).toBeUndefined();
  });

  test.each([
    "demo/dashboard",
    "demo/decisions",
    "demo/work",
    "demo/reviews",
    "demo/docs",
    "demo/catalog",
    "demo/products-1",
    "demo/architecture",
    "demo/checks",
    "demo/log",
  ])("attaches no topicGraph to ordinary route %s", (path) => {
    const page = pages.find((p) => p.path === path);
    assert(page, `ordinary page ${path}`);
    expect(page.topicGraph).toBeUndefined();
  });

  test("omits catalog page when designSystem is absent", () => {
    const plain = makeRepo({ designSystem: undefined });
    expect(repoPages(plain, []).map((p) => p.type)).toEqual([
      "dashboard",
      "decisions",
      "work",
      "reviews",
      "docs",
      "architecture",
      "checks",
      "log",
    ]);
  });
});

describe("siteData", () => {
  const repoWithTopicAndNeed = () =>
    makeRepo({
      key: "demo",
      label: "Demo",
      reports: [
        {
          path: "docs/agent-work/2026-01-12-plan.md",
          stem: "2026-01-12-plan",
          date: "2026-01-12",
          title: "Plan",
          version: "1",
          html: "<p>Plan</p>",
        },
      ],
      items: [
        makeItem({
          id: "second",
          priority: 2,
          title: "Second",
          body: "Second body",
          needs: ["first"],
          topic: "2026-01-12-plan",
        }),
        makeItem({
          id: "first",
          kind: "decision",
          priority: 1,
          title: "First",
          body: "First body",
          options: [
            { key: "a", label: "Alpha" },
            { key: "b", label: "Beta" },
          ],
          recommended: "a",
        }),
      ],
    });

  test("sorts repositories by fallback label, strips workFiles, and leads pages with hub routes", () => {
    const data = siteData([
      makeRepo({ key: "beta", label: undefined, workFiles: ["docs/agent-work/x.md"] }),
      makeRepo({ key: "zeta", label: "Alpha" }),
    ]);
    expect(data.repos.map((r) => [r.key, r.label, r.prefix, r.dashboard])).toEqual([
      ["zeta", "Alpha", "zeta/", "zeta/dashboard"],
      ["beta", "beta", "beta/", "beta/dashboard"],
    ]);
    expect(data.repos[1]).not.toHaveProperty("workFiles");
    expect(data.pages.slice(0, 3).map((p) => [p.path, p.type])).toEqual([
      ["index", "hub"],
      ["architecture", "hub-architecture"],
      ["404", "missing"],
    ]);
  });

  test("preserves serialized JSON key order for SiteData, repository, view items, and topic page", () => {
    const written = JSON.parse(JSON.stringify(siteData([repoWithTopicAndNeed()]))) as SiteData;
    const repoOut = written.repos[0];
    assert(repoOut, "built repository");
    const recommendedItem = repoOut.items[0];
    const dependentItem = repoOut.items[1];
    assert(recommendedItem, "recommended view item");
    assert(dependentItem, "dependent view item");
    const topicPage = written.pages.find((p) => p.doc === "docs/agent-work/2026-01-12-plan.md");
    assert(topicPage, "topic page");
    expect(Object.keys(written)).toEqual(["version", "people", "others", "repos", "pages"]);
    expect(Object.keys(repoOut)).toEqual([
      "key",
      "path",
      "label",
      "head",
      "items",
      "reports",
      "reviews",
      "docs",
      "scripts",
      "agents",
      "products",
      "links",
      "checkSteps",
      "defects",
      "trackingLog",
      "log",
      "pkg",
      "prefix",
      "dashboard",
      "needsSvg",
    ]);
    expect(Object.keys(recommendedItem)).toEqual([
      "kind",
      "status",
      "priority",
      "owner",
      "title",
      "body",
      "id",
      "options",
      "recommended",
      "waitingOn",
      "waitingCount",
      "repo",
      "repoLabel",
      "who",
      "html",
      "agent",
      "optionImages",
      "recommendedKeys",
      "recommendedLabel",
    ]);
    expect(Object.keys(dependentItem)).toEqual([
      "kind",
      "status",
      "priority",
      "owner",
      "title",
      "body",
      "id",
      "needs",
      "topic",
      "waitingOn",
      "waitingCount",
      "repo",
      "repoLabel",
      "who",
      "html",
      "agent",
      "optionImages",
      "recommendedKeys",
    ]);
    expect(Object.keys(topicPage)).toEqual([
      "path",
      "type",
      "doc",
      "title",
      "topic",
      "topicGraph",
      "repo",
    ]);
  });

  test("renders ranked item HTML before topic graphs and the repository needs graph", () => {
    const calls: string[] = [];
    const renderItem = vi
      .spyOn(markdown, "renderItemMarkdown")
      .mockImplementation((_repo, path, body) => {
        calls.push(`item:${path}`);
        return `<p>${body}</p>`;
      });
    const renderDiagram = vi.spyOn(diagrams, "diagram").mockImplementation((source) => {
      calls.push(`diagram:${source}`);
      return "<figure><svg></svg></figure>";
    });
    try {
      siteData([repoWithTopicAndNeed()]);
      expect(calls).toEqual([
        "item:docs/agent-work/items/first.md",
        "item:docs/agent-work/items/second.md",
        'diagram:flowchart LR\nn0["Second"]',
        'diagram:flowchart LR\nn0(["First"])\nn1["Second"]\nn0 --> n1',
      ]);
    } finally {
      renderItem.mockRestore();
      renderDiagram.mockRestore();
    }
  });
});
