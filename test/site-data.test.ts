import { describe, expect, test } from "vitest";
import type { Item } from "../src/items.ts";
import type { RepoData } from "../src/repo.ts";
import {
  createItemHtmlRenderer,
  createOwnerClassifier,
  firstWord,
  repoPages,
  repoViewItems,
  siteData,
  summarizeOwners,
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
          makeItem({ id: "i4", owner: "B+L" }),
          makeItem({ id: "i5", owner: "eBike Works" }),
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
    [
      "classifies lower-case first word as agent",
      "claude-code",
      { who: "claude-code", as: "agent" },
    ],
    ["classifies runtime name as agent", "Codex", { who: "Codex", as: "agent" }],
    ["classifies article-led owner as agent", "The agent", { who: "The", as: "agent" }],
    ["classifies repo-defined agent as agent", "Nova", { who: "Nova", as: "agent" }],
    ["classifies parenthetical owner as agent", "(pending)", { who: "(pending)", as: "agent" }],
    [
      "classifies plus-joined owner up to semicolon as party",
      "B+L; next sprint",
      { who: "B+L", as: "party" },
    ],
    [
      "classifies mixed-case firm up to paren as party",
      "eBike Works (partner)",
      { who: "eBike Works", as: "party" },
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
      makeItem({ id: "p1", kind: "work", owner: "B+L" }),
      makeItem({ id: "g1", kind: "work", owner: "claude-code" }),
    ];
    const classify = createOwnerClassifier([makeRepo({ items })], "Taro");
    expect(summarizeOwners(items, classify, "Taro")).toEqual({
      people: ["Taro", "Mara", "Nora", "Aron", "Bram"],
      others: ["Aron", "B+L", "Bram", "Mara", "Nora"],
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
          owner: "claude-code",
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
  test("emits repository pages in order and adds topicGraph only when topic has work or goal", () => {
    const repo = makeRepo({
      designSystem: "http://127.0.0.1:4332/catalog/",
      products: [{ label: "Web", href: "https://example.invalid/" }],
      reports: [
        {
          path: "docs/agent-work/2026-01-10-decisions-only.md",
          stem: "2026-01-10-decisions-only",
          title: "Decisions Only",
          version: "1",
          html: "<p>D</p>",
        },
        {
          path: "docs/agent-work/2026-01-11-with-work.md",
          stem: "2026-01-11-with-work",
          title: "With Work",
          version: "2",
          html: "<p>W</p>",
        },
      ],
      docs: [{ path: "README.md", title: "Readme", html: "<p>R</p>" }],
      items: [
        makeItem({ id: "d1", kind: "decision", topic: "2026-01-10-decisions-only" }),
        makeItem({ id: "w1", kind: "work", topic: "2026-01-11-with-work" }),
      ],
    });
    const classify = createOwnerClassifier([repo]);
    const items = repoViewItems(repo, classify, () => "");
    const pages = repoPages(repo, items).map((p) => ({
      path: p.path,
      type: p.type,
      topic: p.topic,
      hasTopicGraph: typeof p.topicGraph === "string",
    }));
    expect(pages).toEqual([
      { path: "demo/dashboard", type: "dashboard", topic: undefined, hasTopicGraph: false },
      { path: "demo/decisions", type: "decisions", topic: undefined, hasTopicGraph: false },
      { path: "demo/work", type: "work", topic: undefined, hasTopicGraph: false },
      { path: "demo/reviews", type: "reviews", topic: undefined, hasTopicGraph: false },
      { path: "demo/docs", type: "docs", topic: undefined, hasTopicGraph: false },
      { path: "demo/catalog", type: "catalog", topic: undefined, hasTopicGraph: false },
      { path: "demo/products-1", type: "product", topic: undefined, hasTopicGraph: false },
      { path: "demo/architecture", type: "architecture", topic: undefined, hasTopicGraph: false },
      { path: "demo/checks", type: "checks", topic: undefined, hasTopicGraph: false },
      { path: "demo/log", type: "log", topic: undefined, hasTopicGraph: false },
      {
        path: "demo/doc/docs/agent-work/2026-01-10-decisions-only",
        type: "doc",
        topic: true,
        hasTopicGraph: false,
      },
      {
        path: "demo/doc/docs/agent-work/2026-01-11-with-work",
        type: "doc",
        topic: true,
        hasTopicGraph: true,
      },
      { path: "demo/doc/README", type: "doc", topic: undefined, hasTopicGraph: false },
    ]);
  });

  test("omits catalog page when designSystem is absent", () => {
    const repo = makeRepo({ designSystem: undefined });
    expect(repoPages(repo, []).map((p) => p.type)).toEqual([
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
});
