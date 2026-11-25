import { describe, expect, test } from "vitest";
import {
  cleanMermaidSource,
  createMermaidLoader,
  diagram,
  resolveMermaidRenderer,
  scopeLocalUrls,
  scopeSvg,
  scopeSvgAttribute,
  scopeSvgCss,
  type MermaidRenderer,
} from "../src/diagrams.ts";

describe("resolveMermaidRenderer", () => {
  test("returns renderMermaidSVG from the resolved module", () => {
    const fakeRenderer = (() => "<svg></svg>") as unknown as MermaidRenderer;
    const modules: Record<string, unknown> = {
      "/pkg/mermaid.js": { renderMermaidSVG: fakeRenderer },
    };
    const result = resolveMermaidRenderer(
      (entry) => modules[entry],
      () => "/pkg/mermaid.js",
    );
    expect(result).toBe(fakeRenderer);
  });

  test("returns null when the package is not installed", () => {
    const missing = Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
    const result = resolveMermaidRenderer(
      () => {
        throw new Error("should not load");
      },
      () => {
        throw missing;
      },
    );
    expect(result).toBeNull();
  });

  test("rethrows errors other than MODULE_NOT_FOUND", () => {
    const broken = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(() =>
      resolveMermaidRenderer(
        () => ({}),
        () => {
          throw broken;
        },
      ),
    ).toThrow("permission denied");
  });
});

describe("createMermaidLoader", () => {
  test("looks up an installed renderer only once", () => {
    const fakeRenderer = (() => "<svg></svg>") as unknown as MermaidRenderer;
    let resolves = 0;
    let loads = 0;
    const getRenderer = createMermaidLoader(
      () => {
        loads++;
        return { renderMermaidSVG: fakeRenderer };
      },
      () => {
        resolves++;
        return "/pkg/mermaid.js";
      },
    );
    expect(getRenderer()).toBe(fakeRenderer);
    expect(getRenderer()).toBe(fakeRenderer);
    expect(resolves).toBe(1);
    expect(loads).toBe(1);
  });

  test("caches a missing package lookup so resolve runs only once", () => {
    const missing = Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
    let resolves = 0;
    const getRenderer = createMermaidLoader(
      () => ({}),
      () => {
        resolves++;
        throw missing;
      },
    );
    expect(getRenderer()).toBeNull();
    expect(getRenderer()).toBeNull();
    expect(resolves).toBe(1);
  });
});

describe("cleanMermaidSource", () => {
  test.each([
    [
      "directives, comments, styling, click, and flowchart class lines",
      [
        "%%{init: {'theme': 'forest'}}%%",
        "%% comment",
        "flowchart LR",
        "  a --> b",
        "  classDef hot fill:#f00",
        "  class a hot",
        "  style b fill:#0f0",
        "  linkStyle 0 stroke:#00f",
        '  click a "https://example.invalid/"',
        "  &#115;tyle a fill:#000",
      ].join("\n"),
      ["", "flowchart LR", "  a --> b"].join("\n"),
    ],
    [
      "class declarations kept inside a classDiagram",
      "%% note\nclassDiagram\n  class Alpha\n  class Beta",
      "classDiagram\n  class Alpha\n  class Beta",
    ],
    [
      "classDiagram header with trailing semicolon",
      "classDiagram;\n  class Alpha",
      "classDiagram;\n  class Alpha",
    ],
  ])("cleans %s", (_label, source, expected) => {
    expect(cleanMermaidSource(source)).toBe(expected);
  });
});

describe("scopeLocalUrls", () => {
  test.each([
    {
      label: "unquoted local reference",
      value: "url(#arrow)",
      prefix: "p-",
      expected: "url(#p-arrow)",
    },
    {
      label: "double-quoted local reference",
      value: 'url("#grad")',
      prefix: "p-",
      expected: 'url("#p-grad")',
    },
    {
      label: "single-quoted local reference",
      value: "url('#clip')",
      prefix: "p-",
      expected: "url('#p-clip')",
    },
    {
      label: "external URL stays unchanged",
      value: "url(https://example.invalid/a)",
      prefix: "p-",
      expected: "url(https://example.invalid/a)",
    },
  ])("rewrites $label", ({ value, prefix, expected }) => {
    expect(scopeLocalUrls(value, prefix)).toBe(expected);
  });
});

describe("scopeSvgCss", () => {
  test("drops remote font imports and text rules, scopes selectors and local urls", () => {
    const css =
      [
        "  @import url('https://fonts.googleapis.com/css2?family=Inter');",
        "  text { font-family: Inter; }",
        "  .mono { font-family: monospace; }",
        "  svg, .node { fill: url(#bg); }",
      ].join("\n") + "\n";

    expect(scopeSvgCss(css, "d1-")).toBe("  #d1-svg, #d1-svg .node { fill: url(#d1-bg); }\n");
  });
});

describe("scopeSvgAttribute", () => {
  test.each([
    { label: "local href", name: "href", value: "#node-1", prefix: "p-", expected: "#p-node-1" },
    {
      label: "external href left unchanged",
      name: "href",
      value: "https://example.invalid",
      prefix: "p-",
      expected: undefined,
    },
    { label: "local xlink:href", name: "xlink:href", value: "#m", prefix: "p-", expected: "#p-m" },
    { label: "id attribute", name: "id", value: "a", prefix: "p-", expected: "p-a" },
    {
      label: "multi-token aria-labelledby",
      name: "aria-labelledby",
      value: "t1 t2",
      prefix: "p-",
      expected: "p-t1 p-t2",
    },
    {
      label: "aria-describedby",
      name: "aria-describedby",
      value: "d1",
      prefix: "p-",
      expected: "p-d1",
    },
    {
      label: "data attribute left unchanged",
      name: "data-id",
      value: "url(#x)",
      prefix: "p-",
      expected: undefined,
    },
    {
      label: "marker-end url",
      name: "marker-end",
      value: "url(#arr)",
      prefix: "p-",
      expected: "url(#p-arr)",
    },
  ])("handles $label", ({ name, value, prefix, expected }) => {
    expect(scopeSvgAttribute(name, value, prefix)).toBe(expected);
  });
});

describe("scopeSvg", () => {
  test("prefixes root svg id, style rules, ids, and local refs while keeping data and external href", () => {
    const raw =
      '<svg viewBox="0 0 10 10"><style>svg { fill: url(#g); }</style>' +
      '<defs><marker id="arr"/></defs>' +
      '<path marker-end="url(#arr)" data-label="url(#arr)"\thref="https://example.invalid"/>' +
      '<use href="#arr"/></svg>';

    expect(scopeSvg(raw, "m1-")).toBe(
      '<svg id="m1-svg" viewBox="0 0 10 10"><style>#m1-svg { fill: url(#m1-g); }</style>' +
        '<defs><marker id="m1-arr"/></defs>' +
        '<path marker-end="url(#m1-arr)" data-label="url(#arr)"\thref="https://example.invalid"/>' +
        '<use href="#m1-arr"/></svg>',
    );
  });
});

describe("diagram", () => {
  test("wraps a rendered flowchart in a focusable figure with scoped ids", () => {
    const html = diagram("flowchart LR\n  a --&gt; b", "doc1-");
    expect(html).toContain(
      '<figure class="admin-diagram not-prose" tabindex="0"><svg id="doc1-svg"',
    );
    expect(html).toContain('data-to="b"');
  });

  test("falls back to code and escapes angle brackets, ampersands, and quotes in error text", () => {
    expect(diagram("pie &lt;b&gt;a &amp; &quot;b&quot;&lt;/b&gt;", "doc1-")).toBe(
      '<pre><code class="language-mermaid">pie &lt;b&gt;a &amp; &quot;b&quot;&lt;/b&gt;</code></pre>' +
        "<p>This diagram did not render: Invalid mermaid header: &quot;pie &lt;b&gt;a &amp; &quot;b&quot;&lt;/b&gt;&quot;. Expected &quot;graph TD&quot;, &quot;flowchart LR&quot;, &quot;stateDiagram-v2&quot;, etc.</p>",
    );
  });
});
