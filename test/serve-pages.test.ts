import { assert, describe, expect, test, vi } from "vitest";
import { NOTICE } from "../site/src/data.ts";
import { SHELL, shellPath } from "../src/build.ts";
import { when } from "../src/display.ts";
import type { Doc, RepoData, Report } from "../src/repo.ts";
import {
  createDocFiller,
  createPageDecorator,
  extractShells,
  formatNotice,
  indexDocs,
  linker,
  renderDocShell,
  rewriteMissingPage,
  stampTime,
} from "../src/serve-pages.ts";
import type { Page } from "../src/site-data.ts";

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

describe("linker", () => {
  test("rewrites nested repository prefixes longest path first and preserves data-doc-source", () => {
    const outer = makeRepo({
      key: "outer",
      path: "/r/outer",
      docs: [{ path: "docs/a.md", title: "A", html: "" }],
    });
    const inner = makeRepo({
      key: "inner",
      path: "/r/outer/nested",
      docs: [{ path: "docs/page.html.md", title: "Page", html: "" }],
    });
    const links = linker([outer, inner]);
    expect(
      links.files(
        '<a href="file:///r/outer/nested/img.png"></a><a href="file:///r/outer/img.png"></a>',
      ),
    ).toBe('<a href="/_file/inner/img.png"></a><a href="/_file/outer/img.png"></a>');
    expect(
      links.pages(
        '<a href="file:///r/outer/docs/a.md#sec"></a>' +
          '<a href="file:///r/outer/nested/docs/page.html.md"></a>' +
          '<a data-doc-source href="file:///r/outer/docs/a.md"></a>',
      ),
    ).toBe(
      '<a href="/outer/doc/docs/a#sec"></a>' +
        '<a href="/inner/doc/docs/page.html.html"></a>' +
        '<a data-doc-source href="file:///r/outer/docs/a.md"></a>',
    );
  });
});

describe("extractShells", () => {
  test("moves shell HTML files out of files map and rewrites links on regular HTML while leaving assets untouched", () => {
    const repo = makeRepo({
      docs: [{ path: "README.md", title: "Readme", html: "" }],
    });
    const links = linker([repo]);
    const files = new Map<string, Buffer>([
      [
        "index.html",
        Buffer.from('<a href="file:///r/demo/README.md">R</a><img src="file:///r/demo/a.png">'),
      ],
      [
        "demo/_shell/admin-shell-name.html",
        Buffer.from('<a href="file:///r/demo/a.png">shell</a>'),
      ],
      ["_astro/app.js", Buffer.from('const x = "file:///r/demo/a.png";')],
    ]);
    const pages: Page[] = [
      { path: "index", type: "hub", title: "Hub" },
      {
        path: "demo/_shell/admin-shell-name",
        type: "doc",
        repo: "demo",
        title: SHELL.title,
        article: SHELL,
      },
    ];
    const shells = extractShells(files, pages, links);
    expect(shells.get("demo/_shell/admin-shell-name")).toBe(
      '<a href="/_file/demo/a.png">shell</a>',
    );
    expect(files.has("demo/_shell/admin-shell-name.html")).toBe(false);
    expect(files.get("index.html")?.toString("utf8")).toBe(
      '<a href="/demo/doc/README">R</a><img src="/_file/demo/a.png">',
    );
    expect(files.get("_astro/app.js")?.toString("utf8")).toBe('const x = "file:///r/demo/a.png";');
  });
});

describe("indexDocs", () => {
  test("indexes reports and docs by repo key and doc slug", () => {
    const report: Report = {
      path: "docs/agent-work/2026-01-15-note.md",
      stem: "2026-01-15-note",
      date: "2026-01-15",
      title: "Note",
      version: "1",
      html: "<p>N</p>",
    };
    const doc: Doc = { path: "README.md", title: "Readme", html: "<p>R</p>" };
    const repo = makeRepo({ reports: [report], docs: [doc] });
    const indexed = indexDocs([repo]);
    expect([...indexed.keys()]).toEqual([
      "demo/doc/docs/agent-work/2026-01-15-note",
      "demo/doc/README",
    ]);
    expect(indexed.get("demo/doc/README")).toEqual({ repo, doc });
  });
});

describe("renderDocShell", () => {
  const shell =
    `<title>${SHELL.title}</title>` +
    `<a href="/_file/demo/${SHELL.path}">${SHELL.path}</a>` +
    `<h1 id="${SHELL.titleId}">${SHELL.title}</h1>` +
    `<div class="admin-action bg-background" data-shell-action="1"><button>Copy</button></div>` +
    `<a href="${SHELL.name}.html">self</a>` +
    `<article>${SHELL.html}</article>`;
  const repo = makeRepo();
  const links = linker([repo]);

  test("strips action bar and escapes attributes for an ordinary headingless doc", () => {
    const doc: Doc = {
      path: "docs/rock & roll's.md",
      title: "A <B> & 'C'",
      html: '<p><a href="file:///r/demo/a.png">img</a></p>',
    };
    const rendered = renderDocShell(
      shell,
      { name: "demo/doc/docs/rock & roll's", repoKey: "demo", doc },
      links,
    );
    expect(rendered).toContain("<title>A &lt;B&gt; &amp; &#39;C&#39;</title>");
    expect(rendered).toContain('href="/_file/demo/docs/rock%20%26%20roll%27s.md"');
    expect(rendered).toContain("<h1>A &lt;B&gt; &amp; &#39;C&#39;</h1>");
    expect(rendered).not.toContain("admin-action");
    expect(rendered).toContain('<article><p><a href="/_file/demo/a.png">img</a></p></article>');
  });

  test("keeps action bar without data-shell-action for a plain dated report", () => {
    const report: Report = {
      path: "docs/agent-work/2026-01-15-plan.md",
      stem: "2026-01-15-plan",
      date: "2026-01-15",
      title: "Plan",
      titleId: "plan",
      version: "1",
      html: "<p>Body</p>",
    };
    const rendered = renderDocShell(
      shell,
      { name: "demo/doc/docs/agent-work/2026-01-15-plan", repoKey: "demo", doc: report },
      links,
    );
    expect(rendered).toContain(
      '<div class="admin-action bg-background"><button>Copy</button></div>',
    );
    expect(rendered).toContain('<h1 id="plan">Plan</h1>');
    expect(rendered).toContain('href="2026-01-15-plan.html"');
  });
});

describe("createDocFiller", () => {
  test("fills a doc once per build and returns undefined for an unknown doc", () => {
    const doc: Doc = { path: "README.md", title: "Readme", html: "<p>Hi</p>" };
    const repo = makeRepo({ docs: [doc] });
    const docPage = createDocFiller(
      new Map([[shellPath("demo/", 3), `<main>${SHELL.html}</main>`]]),
      indexDocs([repo]),
      linker([repo]),
    );
    expect(docPage("demo/doc/absent")).toBeUndefined();
    const first = docPage("demo/doc/README");
    assert(first, "filled doc page");
    expect(first.toString("utf8")).toBe("<main><p>Hi</p></main>");
    expect(docPage("demo/doc/README")).toBe(first);
  });
});

describe("rewriteMissingPage", () => {
  test("makes relative URLs root-relative and escapes the missing path", () => {
    const template =
      '<link href="./_astro/a.css"><a href="index.html">Hub</a>' +
      '<a href="https://example.invalid/">Ext</a><a href="#top">Top</a>' +
      "<p>Nothing at admin-missing-path</p>";
    expect(rewriteMissingPage(template, "/a/<b>")).toBe(
      '<link href="/_astro/a.css"><a href="/index.html">Hub</a>' +
        '<a href="https://example.invalid/">Ext</a><a href="#top">Top</a>' +
        "<p>Nothing at /a/&lt;b&gt;</p>",
    );
  });
});

describe("formatNotice", () => {
  const buildAt = Date.UTC(2026, 2, 10, 9, 0);
  const builtAt = Date.UTC(2026, 2, 10, 8, 30);

  test.each([
    { label: "empty when nothing failed", unread: [], buildFailure: undefined, expected: "" },
    {
      label: "single unread repo left out",
      unread: [{ name: "alpha", message: "bad <ref>", hasLastRead: false }],
      buildFailure: undefined,
      expected: `<p><b>The hub could not read a repository.</b> It tries again a minute later, or once a repository changes; nothing to do unless this stays, and then the terminal running admin-serve shows the whole error.</p><ul class="hw-marker-list"><li>alpha could not be read: bad &lt;ref&gt;. It is left out.</li></ul>`,
    },
    {
      label: "two unread repos with mixed last-read states",
      unread: [
        { name: "alpha", message: "err1", hasLastRead: true },
        { name: "beta", message: "err2", hasLastRead: false },
      ],
      buildFailure: undefined,
      expected: `<p><b>The hub could not read 2 repositories.</b> It tries again a minute later, or once a repository changes; nothing to do unless this stays, and then the terminal running admin-serve shows the whole error.</p><ul class="hw-marker-list"><li>alpha could not be read: err1. Its pages show its last read.</li><li>beta could not be read: err2. It is left out.</li></ul>`,
    },
    {
      label: "build failure ahead of unread repo with prior build timestamp",
      unread: [{ name: "alpha", message: "err1", hasLastRead: false }],
      buildFailure: { at: buildAt, message: "boom", builtAt },
      expected: `<p><b>The hub could not rebuild on ${when(buildAt)}.</b> These pages show the repositories as of ${when(builtAt)}. It tries again a minute later, or once a repository changes; nothing to do unless this stays, and then the terminal running admin-serve shows the whole error.</p><ul class="hw-marker-list"><li>The build stopped: boom</li><li>alpha could not be read: err1. It is left out.</li></ul>`,
    },
  ])("formats $label", ({ unread, buildFailure, expected }) => {
    expect(formatNotice(unread, buildFailure)).toBe(expected);
  });
});

describe("stampTime", () => {
  const now = 5_000;
  test.each([
    {
      label: "hub page uses current time",
      repo: undefined,
      fetched: undefined,
      at: now,
      expected: now,
    },
    {
      label: "repo with newer fetch uses fetch time",
      repo: makeRepo({ fetched: 1_000 }),
      fetched: 2_000,
      at: now,
      expected: 2_000,
    },
    {
      label: "repo with unchanged fetch returns undefined",
      repo: makeRepo({ fetched: 1_000 }),
      fetched: 1_000,
      at: now,
      expected: undefined,
    },
    {
      label: "repo never fetched before returns undefined",
      repo: makeRepo({ fetched: undefined }),
      fetched: 2_000,
      at: now,
      expected: undefined,
    },
    {
      label: "repo with absent current fetch returns undefined",
      repo: makeRepo({ fetched: 1_000 }),
      fetched: undefined,
      at: now,
      expected: undefined,
    },
  ])("$label", ({ repo, fetched, at, expected }) => {
    expect(stampTime(repo, fetched, at)).toBe(expected);
  });
});

describe("createPageDecorator", () => {
  test("injects and caches notice until notice text changes", () => {
    const decorator = createPageDecorator(() => undefined);
    const page = Buffer.from(`<div id="admin-problem">${NOTICE}</div>`);
    expect(decorator.withNotice(page)).toBe(page);

    decorator.setNotice("<p>Failed</p>");
    const first = decorator.withNotice(page);
    expect(first.toString("utf8")).toBe('<div id="admin-problem"><p>Failed</p></div>');
    expect(decorator.withNotice(page)).toBe(first);

    decorator.setNotice("<p>Updated</p>");
    expect(decorator.withNotice(page).toString("utf8")).toBe(
      '<div id="admin-problem"><p>Updated</p></div>',
    );
  });

  test("stamps hub pages with current time and repo pages with newer fetch time, caching per minute", () => {
    const t1 = Date.UTC(2026, 2, 10, 9, 5);
    const t2 = Date.UTC(2026, 2, 10, 9, 6);
    const clock = vi.spyOn(Date, "now").mockReturnValue(t1);
    try {
      const repo = makeRepo({ key: "demo", path: "/r/demo", fetched: t1 });
      const decorator = createPageDecorator(() => t2);
      const hubHtml = Buffer.from("<span data-stamp>old</span>");
      const firstHub = decorator.stamp(hubHtml, "index.html", [repo]);
      expect(firstHub.toString("utf8")).toBe(`<span data-stamp>${when(t1)}</span>`);
      expect(decorator.stamp(hubHtml, "index.html", [repo])).toBe(firstHub);

      const repoHtml = Buffer.from("<span data-stamp>old</span>");
      expect(decorator.stamp(repoHtml, "demo/dashboard.html", [repo]).toString("utf8")).toBe(
        `<span data-stamp>${when(t2)}</span>`,
      );
    } finally {
      clock.mockRestore();
    }
  });
});
