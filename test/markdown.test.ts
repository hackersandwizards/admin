import { describe, expect, test, vi } from "vitest";
import {
  decodeLinkPath,
  extractTitle,
  finishRenderedHtml,
  isUnsafeLink,
  renderDocMarkdown,
  renderItemMarkdown,
  renderMermaidBlocks,
  rewriteRelativeUrls,
  sanitizeMarkup,
  stripFrontmatter,
  stripUnsafeLinks,
  tableHeaderLabel,
  tableScroll,
  withElements,
  wrapScrollableTable,
} from "../src/markdown.ts";

describe("tableHeaderLabel", () => {
  test.each([
    [
      "first row with inline tags and extra whitespace",
      "<thead><tr><th> <b>Item</b> </th><th>Cost</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
      "Item Cost",
    ],
    ["blank cells produce empty label", "<tr><td> </td></tr></table>", ""],
    [
      "td cells without thead",
      "<tr><td>Alpha</td><td>Beta</td></tr><tr><td>Ignore</td></tr></table>",
      "Alpha Beta",
    ],
  ])("derives label for %s", (_label, body, expected) => {
    expect(tableHeaderLabel(body)).toBe(expected);
  });
});

describe("wrapScrollableTable", () => {
  test.each([
    {
      label: "labeled table with default class",
      body: "<tr><td>1</td></tr></table>",
      attrs: "",
      name: 'Quoted "A"',
      expected:
        '<div class="hw-table-scroll" tabindex="0" role="region" aria-label="Quoted &quot;A&quot;"><table class="hw-table not-prose"><tr><td>1</td></tr></table></div>',
    },
    {
      label: "unlabeled table preserving attributes",
      body: "<tr><td>1</td></tr></table>",
      attrs: ' class="custom"',
      name: "",
      expected:
        '<div class="hw-table-scroll" tabindex="0"><table class="custom"><tr><td>1</td></tr></table></div>',
    },
  ])("wraps $label", ({ body, attrs, name, expected }) => {
    expect(wrapScrollableTable(body, attrs, name)).toBe(expected);
  });
});

describe("tableScroll", () => {
  test.each([
    [
      "duplicate heading labels numbered from 2",
      "<h2>Costs</h2><table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>",
      '<h2>Costs</h2><div class="hw-table-scroll" tabindex="0" role="region" aria-label="Costs"><table class="hw-table not-prose"><tr><td>a</td></tr></table></div><div class="hw-table-scroll" tabindex="0" role="region" aria-label="Costs (2)"><table class="hw-table not-prose"><tr><td>b</td></tr></table></div>',
    ],
    [
      "table inside a heading stays unwrapped",
      "<h2><table><tr><td>x</td></tr></table></h2>",
      "<h2><table><tr><td>x</td></tr></table></h2>",
    ],
    [
      "heading inside a table does not name the next table",
      "<table><tr><td><h2>Inner</h2></td></tr></table><table><tr><td>After</td></tr></table>",
      '<div class="hw-table-scroll" tabindex="0" role="region" aria-label="Inner"><table class="hw-table not-prose"><tr><td><h2>Inner</h2></td></tr></table></div><div class="hw-table-scroll" tabindex="0" role="region" aria-label="After"><table class="hw-table not-prose"><tr><td>After</td></tr></table></div>',
    ],
  ])("handles %s", (_label, html, expected) => {
    expect(tableScroll(html)).toBe(expected);
  });
});

describe("withElements", () => {
  test.each([
    ["meta tag escaped", '<meta http-equiv="refresh">', '&lt;meta http-equiv="refresh">'],
    [
      "blockquote and link classes",
      '<blockquote><a href="x">t</a></blockquote>',
      '<blockquote class="hw-quote not-prose"><a class="hw-link" href="x">t</a></blockquote>',
    ],
    [
      "task checkbox preserves literal $ sequences in label",
      '<ul>\n<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled>Pay $1 and $&</li></ul>',
      '<ul>\n<li class="task-list-item"><label><input type="checkbox" class="task-list-item-checkbox hw-check" data-readonly disabled>Pay $1 and $&</label></li></ul>',
    ],
  ])("formats %s", (_label, html, expected) => {
    expect(withElements(html)).toBe(expected);
  });
});

describe("isUnsafeLink", () => {
  test.each([
    ["https URL", "https://example.invalid/a", false],
    ["http URL uppercase", "HTTP://example.invalid", false],
    ["mailto URL", "mailto:ops@example.invalid", false],
    ["relative path", "docs/guide.md", false],
    ["path with encoded ampersand", "q&amp;a.md", false],
    ["javascript scheme", "javascript:alert(1)", true],
    ["entity-obfuscated javascript scheme", "&#106;avascript:x", true],
    ["named entity before slash", "javascript&colon;x", true],
    ["control-padded javascript", " \tjava\nscript:x", true],
  ])("classifies %s", (_label, href, expected) => {
    expect(isUnsafeLink(href)).toBe(expected);
  });
});

describe("stripUnsafeLinks", () => {
  test.each([
    ["unsafe anchor keeps text", '<a href="javascript:x">Click</a>', "Click"],
    [
      "safe anchor kept",
      '<a href="https://example.invalid">Docs</a>',
      '<a href="https://example.invalid">Docs</a>',
    ],
    [
      "unsafe xlink:href removed",
      '<svg><a xlink:href="javascript:x"><text>T</text></a></svg>',
      "<svg><text>T</text></svg>",
    ],
    [
      "SVG set targeting href removed",
      '<svg><a><set attributeName="xlink:href" to="javascript:x"/></a></svg>',
      "<svg><a></a></svg>",
    ],
    [
      "SVG animate targeting fill kept",
      '<svg><animate attributeName="fill" values="red"/></svg>',
      '<svg><animate attributeName="fill" values="red"/></svg>',
    ],
  ])("handles %s", (_label, html, expected) => {
    expect(stripUnsafeLinks(html)).toBe(expected);
  });
});

describe("stripFrontmatter", () => {
  test.each([
    ["valid YAML mapping stripped", "---\ntitle: Guide\n---\nBody\n", "Body\n"],
    ["leading horizontal rule kept", "---\n\nIntro\n\n---\nRest\n", "---\n\nIntro\n\n---\nRest\n"],
    ["YAML sequence kept", "---\n- one\n---\nBody\n", "---\n- one\n---\nBody\n"],
    ["invalid YAML kept", "---\n[broken\n---\nBody\n", "---\n[broken\n---\nBody\n"],
  ])("handles %s", (_label, text, expected) => {
    expect(stripFrontmatter(text)).toBe(expected);
  });
});

describe("sanitizeMarkup", () => {
  test("strips data attributes, drops reserved element ids, and deduplicates heading ids", () => {
    const raw =
      '<div data-x="1" data-Y="2" id="admin-panel"><span id="ok">a</span></div>' +
      '<h1 id="copy">Copy</h1><h2 id="intro">Intro</h2><h2 id="intro">Intro</h2><h2 id="!!!">!</h2>';
    expect(sanitizeMarkup(raw)).toBe(
      '<div><span id="ok">a</span></div>' +
        '<h1 id="section-copy">Copy</h1><h2 id="intro">Intro</h2><h2 id="intro-1">Intro</h2><h2 id="---">!</h2>',
    );
  });

  test("falls back to section when a heading id is empty", () => {
    expect(sanitizeMarkup('<h2 id="">Empty</h2>')).toBe('<h2 id="section">Empty</h2>');
  });
});

describe("renderMermaidBlocks", () => {
  test("renders mermaid fences with distinct per-block prefixes and leaves other code alone", () => {
    const html =
      '<pre><code class="language-mermaid">flowchart LR\n  a --&gt; b</code></pre>' +
      '<pre><code class="language-mermaid">flowchart LR\n  c --&gt; d</code></pre>' +
      '<pre><code class="language-ts">const x = 1;</code></pre>';
    const out = renderMermaidBlocks(html, "doc1");
    const ids = [...out.matchAll(/<svg id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["mermaid-doc1-1-svg", "mermaid-doc1-2-svg"]);
    expect(out).toContain('<pre><code class="language-ts">const x = 1;</code></pre>');
  });
});

describe("decodeLinkPath", () => {
  test.each([
    ["percent-encoded space", "first%20draft.md", "first draft.md"],
    ["stray percent kept verbatim", "50%.md", "50%.md"],
  ])("decodes %s", (_label, path, expected) => {
    expect(decodeLinkPath(path)).toBe(expected);
  });
});

describe("rewriteRelativeUrls", () => {
  test.each([
    {
      label: "relative href with query and entity",
      html: '<a href="q&amp;a.md?tab=1#top">Q</a>',
      dir: "/repo/docs",
      expected: '<a href="file:///repo/docs/q%26a.md?tab=1#top">Q</a>',
    },
    {
      label: "relative src with stray percent",
      html: '<img src="50%.png">',
      dir: "/repo/docs",
      expected: '<img src="file:///repo/docs/50%25.png">',
    },
    {
      label: "leading space before scheme stays unchanged",
      html: '<a href="&#32;https://example.invalid/">Link</a>',
      dir: "/repo/docs",
      expected: '<a href="&#32;https://example.invalid/">Link</a>',
    },
    {
      label: "absolute and fragment links stay unchanged",
      html: '<a href="https://example.invalid">A</a><a href="#top">B</a><a href="/root">C</a>',
      dir: "/repo/docs",
      expected: '<a href="https://example.invalid">A</a><a href="#top">B</a><a href="/root">C</a>',
    },
  ])("rewrites $label", ({ html, dir, expected }) => {
    expect(rewriteRelativeUrls(html, dir)).toBe(expected);
  });
});

describe("finishRenderedHtml", () => {
  test("sanitizes before rendering diagrams, styles before stripping unsafe links, and strips unsafe links before rewriting relative URLs", () => {
    const rendered =
      '<h2 id="copy" data-x="1">Copy</h2>\n' +
      '<p><a href="javascript&colon;x">drop</a> <a href="guide.md">keep</a></p>\n' +
      '<pre><code data-x="1" class="language-mermaid">pie bad</code></pre>';
    expect(finishRenderedHtml(rendered, "/r/docs", "doc1")).toBe(
      '<h2 id="section-copy">Copy</h2>\n' +
        '<p>drop <a class="hw-link" href="file:///r/docs/guide.md">keep</a></p>\n' +
        '<pre class="hw-code not-prose"><code class="language-mermaid">pie bad</code></pre>' +
        "<p>This diagram did not render: Invalid mermaid header: &quot;pie bad&quot;. Expected &quot;graph TD&quot;, &quot;flowchart LR&quot;, &quot;stateDiagram-v2&quot;, etc.</p>",
    );
  });
});

describe("renderDocMarkdown and renderItemMarkdown", () => {
  test("renderDocMarkdown strips frontmatter, adds heading ids, and preserves raw HTML", () => {
    const html = renderDocMarkdown(
      "/r",
      "docs/a.md",
      "---\ntitle: T\n---\n# Hello\n\n<em>raw</em>\n",
    );
    expect(html).toBe('<h1 id="hello">Hello</h1>\n<p><em>raw</em></p>\n');
  });

  test("renderItemMarkdown keeps leading rules, omits heading ids, and escapes raw HTML", () => {
    const html = renderItemMarkdown("/r", "docs/agent-work/items/a.md", "---\n# Hello\n\n<tag>\n");
    expect(html).toContain("<hr />");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("&lt;tag&gt;");
  });

  test("does not serialize the source when Markdown contains no Mermaid block", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(renderDocMarkdown("/r", "docs/a.md", "# Plain\n\nBody.\n")).toBe(
        '<h1 id="plain">Plain</h1>\n<p>Body.</p>\n',
      );
      expect(renderItemMarkdown("/r", "docs/agent-work/items/a.md", "Plain body.\n")).toBe(
        "<p>Plain body.</p>\n",
      );
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
});

describe("extractTitle", () => {
  test.each([
    [
      "leading h1 with id and entity removed from html",
      '<h1 id="setup-run">Setup &amp; <em>run</em></h1>\n<p>Body.</p>\n',
      { title: "Setup & run", titleId: "setup-run", html: "<p>Body.</p>\n" },
    ],
    [
      "image-only h1 stays in article",
      '<h1 id="logo"><img src="logo.png"></h1>\n<p>Body.</p>\n',
      { html: '<h1 id="logo"><img src="logo.png"></h1>\n<p>Body.</p>\n' },
    ],
    [
      "document without h1 returns html unchanged",
      "<p>Only text.</p>\n",
      { html: "<p>Only text.</p>\n" },
    ],
  ])("extracts %s", (_label, html, expected) => {
    expect(extractTitle(html)).toEqual(expected);
  });
});
