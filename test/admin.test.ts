import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Window } from "happy-dom";
import { peerDependenciesMeta } from "../package.json";
import { script } from "../src/build.ts";
import { PAGE_TYPES, siteData } from "../src/site-data.ts";
import { findRepos } from "../src/hub.ts";
import { parseItem } from "../src/items.ts";
import { fetchedAt, treeSource } from "../src/git.ts";
import { readItems } from "../src/item-source.ts";
import { renderDocMarkdown } from "../src/markdown.ts";
import { readRepo } from "../src/repo.ts";
import { fileHref } from "../src/repo-paths.ts";
import { withLinks } from "../site/src/data.ts";
import {
  FIX,
  commit,
  configured,
  evaluate,
  fromFiles,
  repoFrom,
  scratch,
  sh,
} from "./admin-fixtures.ts";

describe("admin-check", () => {
  test("admin-check accepts a prerequisite until its tracked item is deleted", () => {
    const repo = repoFrom("spoke");
    const args = ["bun", join(import.meta.dirname, "../bin/admin-check.ts"), repo];
    expect(Bun.spawnSync(args).exitCode).toBe(0);
    rmSync(join(repo, "docs/agent-work/items/check-the-copy.md"));
    const result = Bun.spawnSync(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'work-wire-the-gate.md: needs unknown item "check-the-copy". Use an id for an item in this repository, or remove this entry once the needed item is done',
    );
  });

  test("legacy files and a broken item fail the check", async () => {
    const dir = join(scratch(), "r");
    cpSync(join(FIX, "spoke"), dir, { recursive: true });
    cpSync(join(FIX, "legacy/GOAL.md"), join(dir, "GOAL.md"));
    await Bun.write(join(dir, "docs/agent-work/items/broken.md"), "no frontmatter\n");
    const { defects } = readItems(treeSource(dir));
    expect(defects).toContain("GOAL.md: legacy file, items live in docs/agent-work/items");
    expect(defects).toContain("docs/agent-work/items/broken.md: no frontmatter between --- lines");
    await Bun.write(join(dir, "docs/agent-work/items/gone/shot.jpg"), "x");
    expect(readItems(treeSource(dir)).defects).toContain(
      "docs/agent-work/items/gone/shot.jpg: no item gone.md",
    );
    await Bun.write(join(dir, "docs/tracking/items/old.md"), "x");
    expect(readItems(treeSource(dir)).defects).toContain(
      "docs/tracking/items/old.md: legacy folder, move it to docs/agent-work",
    );
    const cli = Bun.spawnSync(["bun", join(import.meta.dirname, "../bin/admin-check.ts"), dir]);
    expect(cli.exitCode).toBe(1);
  });

  test("--help prints the usage and passes", () => {
    const cli = Bun.spawnSync([
      "bun",
      join(import.meta.dirname, "../bin/admin-check.ts"),
      "--help",
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toMatch(/^Usage: /);
  });

  describe("item body paths and rendering", () => {
    let spoke: Awaited<ReturnType<typeof readRepo>>;
    let other: Awaited<ReturnType<typeof readRepo>>;

    beforeAll(async () => {
      spoke = await readRepo(join(FIX, "spoke"), treeSource(join(FIX, "spoke")));
      other = {
        ...spoke,
        key: "other",
        path: "/o/other",
        items: [],
        workFiles: ["docs/agent-work/notes.md"],
      };
    });

    const renderBody = (body: string) => {
      const item = parseItem(
        "x",
        `---\nkind: work\nstatus: open\npriority: 1\nowner: A\n---\n# X\n\n${body}\n`,
      );
      return siteData([{ ...spoke, items: [item] }, other]).repos.find((r) => r.key === "spoke")!
        .items[0]!.html;
    };

    test.each([
      {
        label: "links a path into the repository named beside it",
        body: "Report: other `docs/agent-work/notes.md`.",
        expected: () =>
          '<p>Report: other <code class="hw-inline-code"><a class="hw-link" href="file:///o/other/docs/agent-work/notes.md">docs/agent-work/notes.md</a></code>.</p>\n',
      },
      {
        label: "leaves a missing git-show path in another repository as text",
        body: "Old: `git show abc~1:docs/agent-work/gone.md` in other.",
        expected: () =>
          '<p>Old: <code class="hw-inline-code">git show abc~1:docs/agent-work/gone.md</code> in other.</p>\n',
      },
      {
        label: "links an existing own work file and leaves a missing one as text",
        body: "Own: docs/agent-work/2026-01-15-sample-topic.md, none: docs/agent-work/missing.md.",
        expected: () =>
          `<p>Own: <a class="hw-link" href="file://${spoke.path}/docs/agent-work/2026-01-15-sample-topic.md">docs/agent-work/2026-01-15-sample-topic.md</a>, none: docs/agent-work/missing.md.</p>\n`,
      },
      {
        label: "resolves a relative Markdown link without keeping ../",
        body: "[relative](../2026-01-15-sample-topic.md)",
        expected: () =>
          `<p><a class="hw-link" href="file://${spoke.path}/docs/agent-work/2026-01-15-sample-topic.md">relative</a></p>\n`,
      },
      {
        // A folder has no file to serve; an item file has.
        label: "leaves a folder path as text and links an item file",
        body: "Folder: docs/agent-work/2026-01-15-sample-topic, item: docs/agent-work/items/goal.md.",
        expected: () =>
          `<p>Folder: docs/agent-work/2026-01-15-sample-topic, item: <a class="hw-link" href="file://${spoke.path}/docs/agent-work/items/goal.md">docs/agent-work/items/goal.md</a>.</p>\n`,
      },
      {
        // A path inside an attribute stays text, so the tag holds.
        label: "leaves a path inside an image alt attribute as text",
        body: "![shot of docs/agent-work/2026-01-15-sample-topic.md](a.png)",
        expected: () =>
          `<p><img src="file://${spoke.path}/docs/agent-work/items/a.png" alt="shot of docs/agent-work/2026-01-15-sample-topic.md" /></p>\n`,
      },
    ])("$label", ({ body, expected }) => {
      expect(renderBody(body)).toBe(expected());
    });

    test("an item body has no front matter so a leading rule stays with the text after it", () => {
      // A body has no front matter: a leading rule stays, with the text after it.
      const base = parseItem(
        "x",
        "---\nkind: work\nstatus: open\npriority: 1\nowner: A\n---\n# X\n",
      );
      const ruled = { ...base, id: "ruled", body: "---\nKept.\n\n---\nAfter." };
      const [rendered] = siteData([{ ...spoke, items: [ruled] }]).repos[0]!.items;
      expect(rendered!.html).toContain("Kept.");
    });

    test("an item without an owner is not marked as agent-owned", () => {
      const base = parseItem(
        "x",
        "---\nkind: work\nstatus: open\npriority: 1\nowner: A\n---\n# X\n",
      );
      const unowned = { ...base, id: "unowned", owner: undefined };
      const [rendered] = siteData([{ ...spoke, items: [unowned] }]).repos[0]!.items;
      expect(rendered!.agent).toBe(false);
    });
  });

  test("a ? in a file's name stays in its path, and an admin link's query stays its query", async () => {
    expect(fileHref("/r/docs/what?.md")).toBe("file:///r/docs/what%3F.md");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ admin: { links: [{ label: "A", href: "a.html?v=1#t" }] } }),
    };
    const { links } = await readRepo("/nonexistent/x", {
      paths: Object.keys(files),
      read: (f) => files[f],
    });
    expect(links[0]!.href).toBe("file:///nonexistent/x/a.html?v=1#t");
  });

  test("an admin href links only over http(s) or as a path; any other scheme shows as text", async () => {
    const bad = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x"];
    const config = (h: string) => ({
      designSystem: h,
      products: [{ label: "P", href: h }],
      links: [{ label: "L", href: h }],
    });
    for (const h of bad)
      for (const files of [
        { "package.json": JSON.stringify({ admin: config(h) }) },
        { "docs/agent-work/admin.json": JSON.stringify(config(h)) },
      ] as Record<string, string>[]) {
        const r = await fromFiles(files);
        expect(r.designSystem).toBeUndefined();
        expect(r.products).toEqual([{ label: "P", href: undefined }]);
        expect(r.links).toEqual([{ label: "L", href: undefined }]);
        expect(r.defects.filter((d) => d.includes("scheme not allowed"))).toHaveLength(3);
      }
    // A leading space or an embedded tab makes it no scheme, so it stays a path in the repository.
    for (const h of [" javascript:x", "java\tscript:x"]) {
      const files = { "package.json": JSON.stringify({ admin: config(h) }) };
      const r = await fromFiles(files);
      for (const out of [r.designSystem, r.products[0]!.href, r.links[0]!.href])
        expect(out?.startsWith("file:///nonexistent/x/")).toBe(true);
    }
    const files = {
      "package.json": JSON.stringify({
        admin: { products: [{ label: "P", href: "https://a.test/" }] },
      }),
    };
    const ok = await fromFiles(files);
    expect(ok.products[0]!.href).toBe("https://a.test/");
    expect(ok.defects).toEqual([]);
  });

  test("no committed <meta> in a doc or item body reaches the page as a tag", async () => {
    const body = [
      '<meta http-equiv="refresh" content="0;url=https://elsewhere.example/">',
      '<META HTTP-EQUIV="refresh" CONTENT="0">',
      '<meta\ncontent="a>b" http-equiv="refresh">',
      "`<meta http-equiv>` in code",
    ].join("\n\n");
    const item = parseItem(
      "m",
      `---\nkind: work\nstatus: open\npriority: 1\nowner: A\n---\n# M\n\n${body}\n`,
    );
    const repo = {
      ...(await readRepo(join(FIX, "spoke"), treeSource(join(FIX, "spoke")))),
      items: [item],
    };
    for (const html of [
      renderDocMarkdown("/r", "docs/a.md", body),
      siteData([repo]).repos[0]!.items[0]!.html,
    ]) {
      expect(html).not.toMatch(/<meta/i);
      expect(html).toContain("&lt;meta http-equiv=");
    }
  });

  test("an item body is Markdown without HTML: a placeholder shows as written, an address stays a link", async () => {
    const item = parseItem(
      "p",
      "---\nkind: work\nstatus: open\npriority: 1\nowner: A\n---\n# P\n\nWrite to <repo>/docs as <title>, see <https://x.example/a>, and `<id>` in code.\n\n<details>\nhidden?\n</details>\n",
    );
    const repo = {
      ...(await readRepo(join(FIX, "spoke"), treeSource(join(FIX, "spoke")))),
      items: [item],
    };
    const html = withLinks(siteData([repo]).repos[0]!.items[0]!.html);
    expect(html).toContain("Write to &lt;repo&gt;/docs as &lt;title&gt;");
    expect(html).toContain("&lt;details&gt;");
    expect(html).toContain(
      'see <a class="hw-link" href="https://x.example/a">https://x.example/a</a>,',
    );
    expect(html).toContain('<code class="hw-inline-code">&lt;id&gt;</code>');
  });

  test("large docs, scripts, and traversal admin.name stay linear and fall back to the folder key", async () => {
    const run = "x".repeat(160_000);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", admin: { name: "../../spoke" } }),
      "docs/src.md": `<div>\n<img src="${run}\n</div>\n`,
      "docs/h1.md": `<div>\n${"<h1>".repeat(40_000)}\n</div>\n`,
      "docs/input.md": `<div>\n${'<input type="checkbox" class="task-list-item-checkbox"'.repeat(40_000)}\n</div>\n`,
      "scripts/a.ts": `// a${" ".repeat(160_000)}b\n`,
      "docs/table.md": `<div>\n${"<table ".repeat(40_000)}\n</div>\n`,
      "docs/h2.md": `<div>\n<h2>${"<".repeat(160_000)}</h2>\n</div>\n`,
    };
    const start = performance.now();
    const repo = await readRepo("/nonexistent/x", {
      paths: Object.keys(files),
      read: (f) => files[f],
    });
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(repo.key).toBe("x");
    expect(repo.defects).toContain(
      'package.json: admin.name "../../spoke" is not letters, digits, ".", "_" and "-": its pages are under x',
    );
  });

  // A dot segment percent-encoded, a route, a colon or a query take the folder name too.
  test.each([
    ["%2e%2e", "x"],
    ["_astro/x", "x"],
    ["a:b", "x"],
    ["a?b", "x"],
    ["..", "x"],
    ["web-site_2.0", "web-site_2.0"],
  ])("admin.name %s resolves to repository key %s", async (name, expectedKey) => {
    const pkg = JSON.stringify({ admin: { name } });
    const read = await readRepo("/nonexistent/x", {
      paths: ["package.json"],
      read: () => pkg,
    });
    expect(read.key).toBe(expectedKey);
  });

  // A folder's name keeps its other characters as "-", and its letters, composed or not.
  test.each([
    ["a#b c:d", "a-b-c-d"],
    ["Größe", "Größe"],
    ["Größe".normalize("NFD"), "Größe".normalize("NFD")],
  ])("folder name %s derives repository key %s", async (folder, expectedKey) => {
    const read = await readRepo(`/nonexistent/${folder}`, { paths: [], read: () => "" });
    expect(read.key).toBe(expectedKey);
  });

  // A label names the repository to a person and leaves its key; one that is not text is a defect.
  test.each([
    ["Sample label", { key: "x", label: "Sample label", defects: [] }],
    [undefined, { key: "x", label: undefined, defects: [] }],
    [" ", { key: "x", label: undefined, defects: [] }],
    [3, { key: "x", label: undefined, defects: ["package.json: admin.label is not text"] }],
  ])("admin.label %o resolves without changing the key", async (label, expected) => {
    expect(await configured("/nonexistent/x", { label })).toMatchObject(expected);
  });

  test("the hub names a repository without a label by its key", async () => {
    // The hub names a repository without one by its key.
    expect(
      siteData([await configured("/nonexistent/x", { label: undefined })]).repos[0]!.label,
    ).toBe("x");
  });

  describe("docs/agent-work/admin.json at HEAD", () => {
    // Read at HEAD, as the hub reads it: no package.json, the file committed beside the items.
    let repo: string;
    let file: string;
    let pkgFile: string;

    beforeAll(() => {
      repo = repoFrom("spoke");
      file = join(repo, "docs/agent-work/admin.json");
      pkgFile = join(repo, "package.json");
      rmSync(pkgFile);
    });

    const commitAdmin = (text: string) => {
      writeFileSync(file, text);
      rmSync(pkgFile, { force: true });
      sh(repo, "git", "add", "-A");
      commit(repo, "admin");
      return readRepo(repo);
    };

    const commitAdminWithPackage = (text: string, pkg: object) => {
      writeFileSync(file, text);
      writeFileSync(pkgFile, JSON.stringify(pkg));
      sh(repo, "git", "add", "-A");
      commit(repo, "admin");
      return readRepo(repo);
    };

    test("reads standalone docs/agent-work/admin.json at HEAD and passes admin-check", async () => {
      const read = await commitAdmin('{ "label": "Sample notes" }');
      expect([read.key, read.label, read.defects]).toEqual(["spoke", "Sample notes", []]);
      // admin-check passes it beside the items.
      expect(readItems(treeSource(repo)).defects).toEqual([]);
    });

    test.each([
      [
        "non-text label",
        '{ "label": 3 }',
        { label: undefined, defects: ["docs/agent-work/admin.json: label is not text"] },
      ],
      [
        "invalid JSON",
        "{",
        { label: undefined, defects: ["docs/agent-work/admin.json: not JSON"] },
      ],
      [
        "JSON array",
        "[]",
        { label: undefined, defects: ["docs/agent-work/admin.json: not a JSON object"] },
      ],
    ])(
      "reports malformed standalone docs/agent-work/admin.json (%s)",
      async (_case, text, expected) => {
        expect(await commitAdmin(text)).toMatchObject(expected);
      },
    );

    test.each([
      {
        // package.json's own admin wins, and the file says it is ignored.
        label: "package.json admin object wins and reports admin.json ignored",
        pkg: { admin: { label: "Own" } },
        expected: {
          label: "Own",
          defects: ["docs/agent-work/admin.json: ignored, package.json holds admin"],
        },
      },
      {
        // An admin there that is no object wins too, and says so.
        label: "non-object package.json admin wins and reports both defects",
        pkg: { admin: null },
        expected: {
          label: undefined,
          defects: [
            "package.json: admin is not an object",
            "docs/agent-work/admin.json: ignored, package.json holds admin",
          ],
        },
      },
    ])("$label", async ({ pkg, expected }) => {
      expect(await commitAdminWithPackage('{ "label": "Sample notes" }', pkg)).toMatchObject(
        expected,
      );
    });
  });
});

describe("hub", () => {
  test("finds each repo with committed items once, skipping dot folders", async () => {
    const repo = repoFrom("spoke");
    const root = dirname(repo);
    sh(root, "git", "clone", "-q", repo, join(root, ".hidden"));
    expect(await findRepos(root)).toEqual([repo]);
  });

  describe("hub discovery and committed design system", () => {
    const bareIn = (dir: string, pkg: object, files: Record<string, string> = {}) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), text);
      }
      sh(dir, "git", "init", "-q", "-b", "main");
      sh(dir, "git", "add", "package.json", ...Object.keys(files));
      commit(dir, "c");
      return dir;
    };

    let root: string;
    let repo: string;
    let tool: string;
    let live: string;

    beforeAll(() => {
      repo = repoFrom("spoke");
      root = dirname(repo);
      tool = bareIn(join(root, "tool"), { name: "@hackersandwizards/tool" });
      bareIn(join(root, "other"), { name: "other" });
      live = bareIn(join(root, "group/live"), { name: "@hackersandwizards/live" });
      bareIn(join(root, "group/_archive/old"), { name: "@hackersandwizards/old" });
    });

    test("finds a repo naming an @hackersandwizards package with no items, and none other or archived", async () => {
      expect(await findRepos(root)).toEqual([live, repo, tool]);
    });

    test("leaves designSystem unset for repositories without a catalog config", async () => {
      expect((await readRepo(tool)).designSystem).toBeUndefined();
      const ui = bareIn(join(scratch(), "ui"), { name: "ui", devDependencies: { astro: "1" } });
      expect((await readRepo(ui)).designSystem).toBeUndefined();
    });

    test("infers designSystem and dev server from a committed astrobook config", async () => {
      const book = await readRepo(
        bareIn(
          join(scratch(), "book"),
          { name: "book", scripts: { dev: "astro dev", "design-system": "astro dev --root ds" } },
          {
            "ds/astro.config.ts":
              'astrobook({ subpath: "/design-system" });\nserver: { host: "127.0.0.1", port: 4999 }',
          },
        ),
      );
      expect(book.designSystem).toBe("http://127.0.0.1:4999/design-system/");
      expect(book.designSystemDev).toEqual({ port: 4999, start: "design-system" });
    });

    test("resolves admin.designSystem and product hrefs relative to the repository", async () => {
      const owned = await readRepo(
        bareIn(join(scratch(), "owned"), {
          name: "owned",
          admin: { designSystem: "catalog.html", products: [{ label: "A", href: "a.html#x" }] },
        }),
      );
      expect(owned.designSystem).toBe(`file://${owned.path}/catalog.html`);
      expect(owned.designSystemDev).toBeUndefined();
      expect(owned.products[0]!.href).toBe(`file://${owned.path}/a.html#x`);
    });
  });

  test("scaffolding's catalog preset links /catalog/ wherever its catalog sits", async () => {
    // An in-memory source: the path rule reads only package.json and the config.
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "shell",
        scripts: { dev: "wrangler dev", catalog: "cd catalog && astro dev" },
      }),
      "catalog/astro.config.ts":
        'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nbase: "/shell",\nserver: { host: "127.0.0.1", port: 4998 }',
    };
    const shell = await readRepo("/nonexistent/shell", {
      paths: Object.keys(files),
      read: (f) => files[f],
    });
    expect(shell.designSystem).toBe("http://127.0.0.1:4998/catalog/");
    expect(shell.designSystemDev).toEqual({ port: 4998, start: "catalog" });
  });

  test.each([
    {
      label: "skips a # comment inside a code fence and strips the rendered h1",
      path: "docs/fenced.md",
      text: "```sh\n# install deps\n```\n\n# Setup &amp; *run*\n\nBody.\n",
      expected: {
        title: "Setup & run",
        html: '<pre class="hw-code not-prose"><code class="language-sh"># install deps\n</code></pre>\n<p>Body.</p>\n',
      },
    },
    {
      label: "strips a setext h1 into the title",
      path: "docs/setext.md",
      text: "Setext title\n============\n\nBody.\n",
      expected: {
        title: "Setext title",
        html: "<p>Body.</p>\n",
      },
    },
    {
      label: "falls back to the file path when no h1 is present",
      path: "docs/none.md",
      text: "Just text.\n",
      expected: {
        title: "docs/none.md",
        html: "<p>Just text.</p>\n",
      },
    },
    {
      label: "falls back to the file path and keeps an image-only h1 in the article",
      path: "docs/image.md",
      text: "# ![logo](logo.png)\n\nBody.\n",
      expected: {
        title: "docs/image.md",
        html: '<h1 id="logo"><img src="file:///nonexistent/titles/docs/logo.png" alt="logo" /></h1>\n<p>Body.</p>\n',
      },
    },
  ])(
    "extracts a doc's title from its first rendered h1: $label",
    async ({ path, text, expected }) => {
      const { docs } = await readRepo("/nonexistent/titles", {
        paths: [path],
        read: () => text,
      });
      expect({ title: docs[0]!.title, html: docs[0]!.html }).toEqual(expected);
    },
  );

  test("reads a worktree's fetch, and a checkout without upstream as commits behind unknown", async () => {
    const repo = repoFrom("spoke");
    const tree = join(dirname(repo), "tree");
    sh(repo, "git", "worktree", "add", "-q", "--detach", tree);
    writeFileSync(
      resolve(tree, sh(tree, "git", "rev-parse", "--git-path", "FETCH_HEAD").trim()),
      "",
    );
    const read = await readRepo(tree);
    expect(read.fetched).toBeTypeOf("number");
    expect(read.behind).toBeUndefined();
  });

  test("a folder git cannot read has no fetch time, and is asked again once it can", async () => {
    const dir = scratch();
    expect(await fetchedAt(dir)).toBeUndefined();
    sh(dir, "git", "init", "-q");
    writeFileSync(join(dir, ".git/FETCH_HEAD"), "");
    expect(await fetchedAt(dir)).toBeTypeOf("number");
  });

  test("a path holding a newline, or a submodule, leaves the rest of a repository readable", async () => {
    const repo = repoFrom("spoke");
    writeFileSync(join(repo, "docs/line\nbreak.md"), "# Broken line\n");
    sh(repo, "git", "add", "-A");
    // A submodule's commit lives in its own repository, so this one has no such object.
    sh(
      repo,
      "git",
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"12".repeat(20)},docs/sub.md`,
    );
    commit(repo, "odd paths");
    const read = await readRepo(repo);
    expect(read.docs.map((d) => d.title)).toContain("Broken line");
    expect(read.docs.map((d) => d.path)).not.toContain("docs/sub.md");
    expect(read.items.length).toBeGreaterThan(0);
  });

  test("reads at HEAD, not the working tree", async () => {
    const repo = repoFrom("spoke");
    await Bun.write(
      join(repo, "docs/agent-work/items/uncommitted.md"),
      readFileSync(join(FIX, "spoke/docs/agent-work/items/check-the-copy.md")),
    );
    expect((await readRepo(repo)).items.map((i) => i.id)).not.toContain("uncommitted");
  });
});

describe("pages", () => {
  describe("waiting on others", () => {
    let repo: Awaited<ReturnType<typeof readRepo>>;

    beforeAll(async () => {
      repo = await readRepo(join(FIX, "spoke"), treeSource(join(FIX, "spoke")));
    });

    const owned = (owner: string) => ({
      ...repo.items[0]!,
      id: owner,
      status: "open" as const,
      owner,
    });

    test("lists repository agents and every person owning an open item", () => {
      expect(repo.agents).toEqual(["Ivo"]);
      // The filter offers every person who owns an open item, work alone included.
      expect(siteData([repo]).people.toSorted()).toEqual(["Alex", "Kim", "Sam"]);
    });

    test.each([
      {
        // The first person stands for the hub's user when none is named.
        label: "default (none named)",
        hubUser: undefined,
        firstPerson: "Alex",
        others: ["Kim", "Sam"],
      },
      {
        // The person filter starts on the hub's user, who comes first.
        label: "named owner Sam",
        hubUser: "Sam",
        firstPerson: "Sam",
        others: ["Alex", "Kim"],
      },
      {
        // A git name no owner writes stands for nobody: the first person does.
        label: "unmatched git name kimlee",
        hubUser: "kimlee",
        firstPerson: "Alex",
        others: ["Kim", "Sam"],
      },
    ])(
      "computes others and default person order for hub user $label",
      ({ hubUser, firstPerson, others }) => {
        const data = siteData([repo], hubUser);
        expect(data.others).toEqual(others);
        expect(data.people[0]).toBe(firstPerson);
      },
    );

    test("keeps generic agent phrases out of waiting on others", () => {
      const more = { ...repo, items: [...repo.items, owned("An agent"), owned("The agent")] };
      expect(siteData([more]).others).toEqual(["Kim", "Sam"]);
    });

    test("assigns an item drafted by an agent to the person named in its owner", () => {
      // The person is whoever the owner names, wherever: an agent drafting first leaves the item
      // the person's.
      const sends = siteData([{ ...repo, items: [...repo.items, owned("Ivo drafts, Kim sends")] }]);
      const row = sends.repos[0]!.items.find((i) => i.id === "Ivo drafts, Kim sends")!;
      expect([row.who, row.agent]).toEqual(["Kim", false]);
    });

    test("matches whole person names so Kim does not stand for Kim-Lee", () => {
      // A name is whole: Kim never stands for Kim-Lee.
      const pair = siteData([{ ...repo, items: [owned("Kim"), owned("Kim-Lee")] }]);
      expect(pair.repos[0]!.items.map((i) => i.who)).toEqual(["Kim", "Kim-Lee"]);
    });

    test("recognizes the hub user when only a later word of an owner names them", () => {
      // The hub's user counts as a person where only a later word of an owner names them.
      expect(
        siteData([{ ...repo, items: [owned("Ivo drafts, Zoe sends")] }], "Zoe").repos[0]!.items[0]!
          .who,
      ).toBe("Zoe");
    });

    test("keeps companies and teams under waiting on others without adding person buttons", () => {
      // An owner that is a company or a team keeps its whole name, gets no button of its own, and
      // waits under "Waiting on others": neither a person cut at a "+" nor an agent.
      const parties = ["B+L", "eBike Works", "x&y", "eBike Works, then Kim", "B+L; next week"];
      const firms = siteData([{ ...repo, items: [...repo.items, ...parties.map(owned)] }]);
      expect(firms.people.toSorted()).toEqual(["Alex", "Kim", "Sam"]);
      expect(firms.others).toEqual(["B+L", "Kim", "Sam", "eBike Works", "x&y"]);
      const of = (id: string) => firms.repos[0]!.items.find((i) => i.id === id)!;
      expect(parties.map((p) => [of(p).who, of(p).agent])).toEqual([
        ["B+L", false],
        ["eBike Works", false],
        ["x&y", false],
        ["Kim", false],
        ["B+L", false],
      ]);
    });

    test("ends person names at punctuation and treats hyphenated or bracketed non-people as agents", () => {
      // A person's name ends at any other mark, an agent's word may hold a hyphen, and an owner
      // opening with a bracket names no company.
      const marks = ["Sam.", "Kim's team", "claude-code", "agent:", "(tbd)"];
      const marked = siteData([{ ...repo, items: [...repo.items, ...marks.map(owned)] }]);
      expect(marked.others).toEqual(["Kim", "Sam"]);
      const at = (id: string) => marked.repos[0]!.items.find((i) => i.id === id)!;
      expect(marks.map((m) => [at(m).who, at(m).agent])).toEqual([
        ["Sam", false],
        ["Kim", false],
        ["claude-code", true],
        ["agent", true],
        ["(tbd)", true],
      ]);
    });
  });

  test("leaving a page asks nothing: answers are stored as they are typed", async () => {
    const theme = readFileSync(join(import.meta.dirname, "../site/src/theme.js"), "utf8");
    expect(`${theme}\n${await script()}`).not.toMatch(/beforeunload/);
  });
});

describe("admin.js", () => {
  const opened: Window[] = [];
  afterAll(async () => {
    await Promise.all(opened.map((w) => w.happyDOM.close()));
  });

  test.each([
    ["light", undefined],
    ["dark", "dark"],
  ] as const)(
    "an explicitly light page stays light and an unset page follows a %s system",
    (prefersColorScheme, expectedTheme) => {
      const theme = readFileSync(join(import.meta.dirname, "../site/src/theme.js"), "utf8");
      const window = new Window({
        url: "http://admin.localhost/index",
        settings: { device: { prefersColorScheme } },
      });
      opened.push(window);
      window.localStorage.setItem("theme", "light");
      evaluate(window, theme);
      expect(window.document.documentElement.dataset.theme).toBeUndefined();
      window.localStorage.removeItem("theme");
      evaluate(window, theme);
      expect(window.document.documentElement.dataset.theme).toBe(expectedTheme);
    },
  );
});

describe("serve", () => {
  test("a repository that never serves the hub installs no Tailwind or Astro for it", () => {
    // admin-serve stops and names a missing optional peer, so only a repository that serves pins it.
    for (const p of ["astro", "tailwindcss", "@tailwindcss/vite", "@tailwindcss/typography"])
      expect(peerDependenciesMeta).toHaveProperty([p, "optional"], true);
  });
});

describe("catalog", () => {
  const stories = join(import.meta.dirname, "../catalog/stories");
  const storyText = (readdirSync(stories, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".stories.ts"))
    .map((f) => readFileSync(join(stories, f), "utf8"))
    .join("\n");

  test("every component and every page type has a story", () => {
    const components = readdirSync(join(import.meta.dirname, "../site/src/components"));
    expect(components.length).toBeGreaterThan(0);
    for (const c of components) expect(storyText).toContain(`/site/src/components/${c}"`);
    for (const t of PAGE_TYPES) expect(storyText).toContain(`page("${t}")`);
  });
});
