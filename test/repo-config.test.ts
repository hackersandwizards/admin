import { describe, expect, test } from "vitest";
import {
  findAstrobookDev,
  parseAdminFile,
  parseAdminSource,
  parseAstroCatalogConfig,
  parsePackageJson,
  pickCatalogStartScript,
  readCheckSteps,
  readPackageBin,
  readPackageTextMap,
  readRepoConfig,
  resolveAdminHref,
  resolveDesignSystemHref,
  resolveLinkedEntries,
  resolveRepoKey,
  resolveRepoLabel,
  selectDesignSystem,
} from "../src/repo-config.ts";

describe("parsePackageJson", () => {
  test.each([
    ["missing file", undefined, { pkg: {}, defects: [] }],
    ["valid object", '{"name":"demo"}', { pkg: { name: "demo" }, defects: [] }],
    ["non-object JSON", "[]", { pkg: {}, defects: ["package.json: not an object"] }],
    ["invalid JSON", "{", { pkg: {}, defects: ["package.json: not JSON"] }],
  ])("parses %s", (_label, text, expected) => {
    expect(parsePackageJson(text)).toEqual(expected);
  });
});

describe("readPackageTextMap", () => {
  test.each([
    { label: "absent field", pkg: {}, field: "scripts", expected: { value: {}, defects: [] } },
    {
      label: "valid string entries",
      pkg: { scripts: { test: "vitest" } },
      field: "scripts",
      expected: { value: { test: "vitest" }, defects: [] },
    },
    {
      label: "non-object field",
      pkg: { dependencies: ["bad"] },
      field: "dependencies",
      expected: {
        value: {},
        defects: ["package.json: dependencies holds a value that is not text"],
      },
    },
    {
      label: "mixed string and non-string entries",
      pkg: { scripts: { ok: "echo", bad: 1 } },
      field: "scripts",
      expected: {
        value: { ok: "echo" },
        defects: ["package.json: scripts holds a value that is not text"],
      },
    },
  ])("reads $label", ({ pkg, field, expected }) => {
    expect(readPackageTextMap(pkg, field)).toEqual(expected);
  });
});

describe("readPackageBin", () => {
  test.each([
    [
      "string bin with package name",
      { name: "tool", bin: "./cli.ts" },
      { value: { tool: "./cli.ts" }, defects: [] },
    ],
    [
      "string bin without package name",
      { bin: "./cli.ts" },
      { value: { undefined: "./cli.ts" }, defects: [] },
    ],
    [
      "object bin with non-text entry",
      { bin: { ok: "./a.ts", bad: true } },
      { value: { ok: "./a.ts" }, defects: ["package.json: bin holds a value that is not text"] },
    ],
  ])("reads %s", (_label, pkg, expected) => {
    expect(readPackageBin(pkg)).toEqual(expected);
  });
});

describe("parseAdminFile", () => {
  test.each([
    ["absent file", undefined, { value: undefined, defects: [] }],
    ["valid object", '{"label":"Demo"}', { value: { label: "Demo" }, defects: [] }],
    ["JSON array", "[]", { value: [], defects: ["docs/agent-work/admin.json: not a JSON object"] }],
    [
      "malformed JSON",
      "{",
      { value: undefined, defects: ["docs/agent-work/admin.json: not JSON"] },
    ],
  ])("parses %s", (_label, text, expected) => {
    expect(parseAdminFile(text)).toEqual(expected);
  });
});

describe("parseAdminSource", () => {
  test.each([
    {
      label: "package admin alone",
      pkgAdmin: { label: "Pkg" },
      ownText: undefined,
      expected: { admin: { label: "Pkg" }, from: "package.json: admin.", defects: [] },
    },
    {
      label: "standalone admin.json alone",
      pkgAdmin: undefined,
      ownText: '{"label":"Own"}',
      expected: { admin: { label: "Own" }, from: "docs/agent-work/admin.json: ", defects: [] },
    },
    {
      label: "package admin overrides admin.json",
      pkgAdmin: { label: "Pkg" },
      ownText: '{"label":"Own"}',
      expected: {
        admin: { label: "Pkg" },
        from: "package.json: admin.",
        defects: ["docs/agent-work/admin.json: ignored, package.json holds admin"],
      },
    },
    {
      label: "non-object package admin still ignores admin.json",
      pkgAdmin: null,
      ownText: '{"label":"Own"}',
      expected: {
        admin: {},
        from: "package.json: admin.",
        defects: [
          "package.json: admin is not an object",
          "docs/agent-work/admin.json: ignored, package.json holds admin",
        ],
      },
    },
  ])("resolves $label", ({ pkgAdmin, ownText, expected }) => {
    expect(parseAdminSource(pkgAdmin, ownText)).toEqual(expected);
  });
});

describe("resolveRepoKey", () => {
  test.each([
    {
      label: "valid configured name",
      repo: "/r/my repo",
      name: "web-site_2.0",
      from: "package.json: admin.",
      expected: { key: "web-site_2.0", defects: [] },
    },
    {
      label: "missing name uses folder key",
      repo: "/r/my repo",
      name: undefined,
      from: "package.json: admin.",
      expected: { key: "my-repo", defects: [] },
    },
    {
      label: "invalid name falls back with defect",
      repo: "/r/my repo",
      name: "../bad",
      from: "package.json: admin.",
      expected: {
        key: "my-repo",
        defects: [
          'package.json: admin.name "../bad" is not letters, digits, ".", "_" and "-": its pages are under my-repo',
        ],
      },
    },
  ])("resolves $label", ({ repo, name, from, expected }) => {
    expect(resolveRepoKey(repo, name, from)).toEqual(expected);
  });
});

describe("resolveRepoLabel", () => {
  test.each([
    ["undefined label", undefined, { label: undefined, defects: [] }],
    ["trimmed string label", "  Demo  ", { label: "Demo", defects: [] }],
    ["blank string label", "   ", { label: undefined, defects: [] }],
    [
      "non-string label",
      9,
      { label: undefined, defects: ["package.json: admin.label is not text"] },
    ],
  ])("resolves %s", (_label, raw, expected) => {
    expect(resolveRepoLabel(raw, "package.json: admin.")).toEqual(expected);
  });
});

describe("resolveAdminHref", () => {
  test.each([
    ["https link", "https://example.invalid/a", { href: "https://example.invalid/a" }],
    ["http link uppercase", "HTTP://example.invalid/", { href: "HTTP://example.invalid/" }],
    [
      "disallowed scheme",
      "javascript:alert(1)",
      { defect: "package.json: admin.designSystem: scheme not allowed, not linked" },
    ],
    [
      "relative path with query and fragment",
      "docs/guide.md?v=1#top",
      { href: "file:///r/demo/docs/guide.md?v=1#top" },
    ],
    [
      "leading space stays a relative path",
      " javascript:x",
      { href: "file:///r/demo/%20javascript:x" },
    ],
  ])("resolves %s", (_label, rawHref, expected) => {
    expect(resolveAdminHref("/r/demo", rawHref, "package.json: admin.designSystem")).toEqual(
      expected,
    );
  });
});

describe("resolveDesignSystemHref", () => {
  test.each([
    ["non-string configured value", 123, { defects: [] }],
    [
      "valid https value",
      "https://example.invalid/ds/",
      { href: "https://example.invalid/ds/", defects: [] },
    ],
    [
      "disallowed scheme value",
      "data:text/html,x",
      {
        href: undefined,
        defects: ["package.json: admin.designSystem: scheme not allowed, not linked"],
      },
    ],
  ])("resolves %s", (_label, configured, expected) => {
    expect(resolveDesignSystemHref("/r/demo", configured, "package.json: admin.")).toEqual(
      expected,
    );
  });
});

describe("resolveLinkedEntries", () => {
  test("drops incomplete entries, preserves descriptions, and reports disallowed schemes", () => {
    const result = resolveLinkedEntries(
      "/r/demo",
      [
        { label: "Docs", href: "docs/index.html", description: "Main docs" },
        { label: "Bad", href: "javascript:x" },
        { label: "Missing href" },
        null as unknown as { label?: unknown; href?: unknown },
      ],
      "package.json: admin.products",
    );
    expect(result).toEqual({
      entries: [
        { label: "Docs", href: "file:///r/demo/docs/index.html", description: "Main docs" },
        { label: "Bad", href: undefined },
      ],
      defects: ['package.json: admin.products "Bad": scheme not allowed, not linked'],
    });
  });

  test("returns empty results for a non-array list", () => {
    expect(
      resolveLinkedEntries(
        "/r/demo",
        "not-a-list" as unknown as { label?: unknown; href?: unknown }[],
        "package.json: admin.links",
      ),
    ).toEqual({
      entries: [],
      defects: [],
    });
  });
});

describe("parseAstroCatalogConfig", () => {
  test.each([
    ["plain astro config without catalog", "export default { server: { port: 4321 } }", undefined],
    ["catalog config without port", 'import "astrobook"; export default {}', undefined],
    [
      "scaffolding catalog preset ignores base",
      'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nbase: "/ignored",\nport: 4332',
      { url: "http://127.0.0.1:4332/catalog/", port: 4332, preset: true },
    ],
    [
      "astrobook with base and subpath",
      'astrobook({ subpath: "/ui" });\nbase: "/app",\nserver: { port: 4555 }',
      { url: "http://127.0.0.1:4555/app/ui/", port: 4555, preset: false },
    ],
    [
      "astrobook without base or subpath",
      'import "astrobook"; server: { port: 4555 }',
      { url: "http://127.0.0.1:4555/", port: 4555, preset: false },
    ],
  ])("parses %s", (_label, text, expected) => {
    expect(parseAstroCatalogConfig(text)).toEqual(expected);
  });
});

describe("pickCatalogStartScript", () => {
  test.each<{
    label: string;
    scripts: Record<string, string>;
    dir: string;
    expected: string | undefined;
  }>([
    {
      label: "prefers script containing design for matching subdir",
      scripts: { dev: "astro dev --root ds", "design-system": "astro dev --root ds" },
      dir: "ds",
      expected: "design-system",
    },
    {
      label: "falls back to dev for root config while skipping --root and cd",
      scripts: {
        other: "astro dev --root sub",
        cd: "cd sub && astro dev",
        dev: "astro dev",
        start: "astro dev --port 4000",
      },
      dir: "",
      expected: "dev",
    },
    {
      label: "falls back to first matching script when neither design nor dev matches",
      scripts: { preview: "astro dev --root catalog" },
      dir: "catalog",
      expected: "preview",
    },
    {
      label: "returns undefined when no script runs astro dev for the dir",
      scripts: { dev: "astro dev" },
      dir: "catalog",
      expected: undefined,
    },
  ])("selects start script: $label", ({ scripts, dir, expected }) => {
    expect(pickCatalogStartScript(scripts, dir)).toBe(expected);
  });
});

describe("findAstrobookDev", () => {
  test("prefers catalog script for scaffolding preset and skips non-catalog astro configs", () => {
    const files: Record<string, string> = {
      "astro.config.ts": "export default { server: { port: 4321 } }",
      "catalog/astro.config.ts":
        'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nserver: { port: 4332 }',
    };
    const src = { paths: Object.keys(files), read: (p: string) => files[p] };
    expect(
      findAstrobookDev(src, {
        catalog: "astro dev --root catalog",
        "design-system": "astro dev --root catalog",
        dev: "wrangler dev",
      }),
    ).toEqual({
      url: "http://127.0.0.1:4332/catalog/",
      port: 4332,
      start: "catalog",
    });
  });

  test("falls back to pickCatalogStartScript when preset has no catalog script", () => {
    const files: Record<string, string> = {
      "catalog/astro.config.ts":
        'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nserver: { port: 4332 }',
    };
    const src = { paths: Object.keys(files), read: (p: string) => files[p] };
    expect(findAstrobookDev(src, { "design-preview": "astro dev --root catalog" })).toEqual({
      url: "http://127.0.0.1:4332/catalog/",
      port: 4332,
      start: "design-preview",
    });
  });
});

describe("selectDesignSystem", () => {
  const dev = { url: "http://127.0.0.1:4332/catalog/", port: 4332, start: "catalog" };

  test.each([
    {
      label: "uses dev server when no designSystem is configured",
      configured: undefined,
      dev,
      expected: { designSystem: dev.url, designSystemDev: { port: 4332, start: "catalog" } },
    },
    {
      label: "omits designSystemDev when configured URL differs from dev",
      configured: "https://example.invalid/catalog/",
      dev,
      expected: { designSystem: "https://example.invalid/catalog/", designSystemDev: undefined },
    },
    {
      label: "keeps designSystemDev when configured URL matches dev URL",
      configured: dev.url,
      dev,
      expected: { designSystem: dev.url, designSystemDev: { port: 4332, start: "catalog" } },
    },
  ])("chooses design system: $label", ({ configured, dev: d, expected }) => {
    expect(selectDesignSystem(configured, d)).toEqual(expected);
  });
});

describe("readCheckSteps", () => {
  test.each([
    [
      "prefers check:all over check",
      { "check:all": " lint &&  test && ", check: "old" },
      ["lint", "test"],
    ],
    ["falls back to check", { check: "typecheck && unit" }, ["typecheck", "unit"]],
    ["empty when neither exists", { dev: "bun run dev" }, []],
  ])("%s", (_label, scripts, expected) => {
    expect(readCheckSteps(scripts)).toEqual(expected);
  });
});

describe("readRepoConfig", () => {
  test("combines package metadata, standalone admin.json, and catalog discovery", () => {
    const files: Record<string, string> = {
      "docs/agent-work/admin.json": JSON.stringify({
        label: "Sample repo",
        links: [{ label: "Site", href: "https://example.invalid" }],
      }),
      "package.json": JSON.stringify({
        name: "sample",
        version: "1.2.3",
        scripts: { check: "lint && test" },
        dependencies: { a: "1.0.0" },
        devDependencies: { b: "2.0.0" },
      }),
    };
    const config = readRepoConfig("/r/sample", {
      paths: Object.keys(files),
      read: (p) => files[p],
    });
    expect(config).toEqual({
      key: "sample",
      label: "Sample repo",
      pkg: {
        name: "sample",
        version: "1.2.3",
        dependencies: { a: "1.0.0", b: "2.0.0" },
        scripts: { check: "lint && test" },
        bin: {},
      },
      designSystem: undefined,
      designSystemDev: undefined,
      products: [],
      links: [{ label: "Site", href: "https://example.invalid" }],
      checkSteps: ["lint", "test"],
      defects: [],
    });
  });
});
