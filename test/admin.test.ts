import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSite, siteData } from "../src/build.ts";
import { findRepos } from "../src/hub.ts";
import { itemDefects, parseItem, type Item } from "../src/items.ts";
import { gitEnv, readItems, readRepo, renderMarkdown, treeSource } from "../src/repo.ts";
import { createHub, CSP } from "../src/serve.ts";

const FIX = join(import.meta.dir, "fixtures");
const made: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "admin-test-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe", env: gitEnv });
  if (r.exitCode) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
// A git repository holding a copy of a fixture, committed, as the hub reads it.
function repoFrom(fixture: string, name = "spoke") {
  const dir = join(scratch(), name);
  cpSync(join(FIX, fixture), dir, { recursive: true });
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "c");
  return dir;
}

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
  ] as [Partial<Item>, string][])("defect %#: %p", (change, message) => {
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

  test("parse rejects an unknown field and a missing title", () => {
    expect(() => parseItem("x", "---\nkind: review\ncolour: red\n---\n\n# T\n")).toThrow(
      "unknown field colour",
    );
    expect(() => parseItem("x", "---\nkind: review\n---\n\nNo title.\n")).toThrow("# <title>");
  });
});

describe("admin-check", () => {
  test("the spoke fixture is clean", () => {
    const { items, defects } = readItems(treeSource(join(FIX, "spoke")));
    expect(defects).toEqual([]);
    expect(items.map((i) => i.id).sort()).toEqual([
      "cache-folder",
      "check-the-copy",
      "goal",
      "pick-a-logo",
      "pick-a-variant",
      "pick-recipients",
      "work-wire-the-gate",
    ]);
  });

  test("legacy files and a broken item fail the check", () => {
    const dir = join(scratch(), "r");
    cpSync(join(FIX, "spoke"), dir, { recursive: true });
    cpSync(join(FIX, "legacy/GOAL.md"), join(dir, "GOAL.md"));
    Bun.write(join(dir, "docs/agent-work/items/broken.md"), "no frontmatter\n");
    const { defects } = readItems(treeSource(dir));
    expect(defects).toContain("GOAL.md: legacy file, items live in docs/agent-work/items");
    expect(defects).toContain("docs/agent-work/items/broken.md: no frontmatter between --- lines");
    Bun.write(join(dir, "docs/agent-work/items/gone/shot.jpg"), "x");
    expect(readItems(treeSource(dir)).defects).toContain(
      "docs/agent-work/items/gone/shot.jpg: no item gone.md",
    );
    Bun.write(join(dir, "docs/tracking/items/old.md"), "x");
    expect(readItems(treeSource(dir)).defects).toContain(
      "docs/tracking/items/old.md: legacy folder, move it to docs/agent-work",
    );
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../bin/admin-check.ts"), dir]);
    expect(cli.exitCode).toBe(1);
  });

  test("a malformed item shows as a defect and leaves the pages building", async () => {
    const dir = join(scratch(), "r");
    cpSync(join(FIX, "spoke"), dir, { recursive: true });
    const front = "kind: decision\nstatus: open\npriority: 1\nowner: 5\ndue: 5";
    writeFileSync(
      join(dir, "docs/agent-work/items/odd.md"),
      `---\n${front}\noptions: foo\nimages:\n  - caption: x\n---\n# Odd\n`,
    );
    const repo = readRepo(dir, treeSource(dir));
    expect(repo.defects.join("\n")).toContain("odd.md: options is not a list");
    const out = join(scratch(), "out");
    await buildSite(siteData([repo]), out);
    expect(readFileSync(join(out, "r/decisions.html"), "utf8")).toContain("Odd");
  });

  test("a stray % in a Markdown link stays as written", () => {
    expect(renderMarkdown("/r", "docs/a.md", "[half](50%.md)")).toContain("docs/50%25.md");
  });

  test("a task list wears no marker beside its checkboxes", () => {
    const html = renderMarkdown("/r", "docs/a.md", "- [ ] open\n- [x] done\n\nNext:\n\n- plain\n");
    expect(html.match(/hw-marker-list/g)).toHaveLength(1);
    expect(html).toContain('<ul>\n<li class="task-list-item">');
  });
});

describe("hub", () => {
  test("finds each repo with committed items once, skipping dot folders", () => {
    const repo = repoFrom("spoke");
    const root = dirname(repo);
    sh(root, "git", "clone", "-q", repo, join(root, ".hidden"));
    expect(findRepos(root)).toEqual([repo]);
  });

  test("finds a repo naming an @hackersandwizards package with no items, and none other", () => {
    const repo = repoFrom("spoke");
    const root = dirname(repo);
    const bare = (name: string, pkg: object, files: Record<string, string> = {}) => {
      const dir = join(root, name);
      Bun.spawnSync(["mkdir", dir]);
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
      for (const [f, text] of Object.entries(files)) {
        Bun.spawnSync(["mkdir", "-p", dirname(join(dir, f))]);
        writeFileSync(join(dir, f), text);
      }
      sh(dir, "git", "init", "-q", "-b", "main");
      sh(dir, "git", "add", "package.json", ...Object.keys(files));
      sh(
        dir,
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "c",
      );
      return dir;
    };
    const tool = bare("tool", { name: "@hackersandwizards/tool" });
    bare("other", { name: "other" });
    expect(findRepos(root)).toEqual([repo, tool]);
    expect(readRepo(tool).designSystem).toBeUndefined();
    // A frontend without Astrobook has no design system; Astrobook's own config gives port and path.
    expect(readRepo(bare("ui", { name: "ui", devDependencies: { astro: "1" } })).designSystem).toBe(
      undefined,
    );
    const book = readRepo(
      bare(
        "book",
        { name: "book", scripts: { dev: "astro dev", "design-system": "astro dev --root ds" } },
        {
          "ds/astro.config.ts":
            'astrobook({ subpath: "/design-system" });\nserver: { host: "127.0.0.1", port: 4999 }',
        },
      ),
    );
    expect(book.designSystem).toBe("http://127.0.0.1:4999/design-system/");
    expect(book.designSystemDev).toEqual({ port: 4999, start: "design-system" });
    const owned = readRepo(
      bare("owned", {
        name: "owned",
        admin: { designSystem: "catalogue.html", products: [{ label: "A", href: "a.html#x" }] },
      }),
    );
    expect(owned.designSystem).toBe(`file://${owned.path}/catalogue.html`);
    expect(owned.designSystemDev).toBeUndefined();
    expect(owned.products[0]!.href).toBe(`file://${owned.path}/a.html#x`);
  });

  test("scaffolding's catalog preset sits where its pin's rule puts it", () => {
    // An in-memory source: the path rule reads only package.json, the config and the paths.
    const preset = (pin: string, page: string) => {
      const files: Record<string, string> = {
        "package.json": JSON.stringify({
          name: "shell",
          scripts: { dev: "wrangler dev", catalog: "cd catalog && astro dev" },
          devDependencies: {
            "@hackersandwizards/scaffolding": `git+https://x.invalid/s.git#${pin}`,
          },
        }),
        "catalog/astro.config.ts":
          'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nbase: "/shell",\nsrcDir: ".",\nserver: { host: "127.0.0.1", port: 4998 }',
        [`catalog/pages/${page}`]: "",
      };
      return readRepo("/nonexistent/shell", { paths: Object.keys(files), read: (f) => files[f] });
    };
    expect(preset("v2.1.0", "types/a.astro").designSystemDev).toEqual({
      port: 4998,
      start: "catalog",
    });
    for (const [pin, page, path] of [
      ["v2.1.0", "types/a.astro", "/"],
      ["v2.1.0", "index.html.ts", "/catalog/"],
      ["v2.0.1", "[...slug].astro", "/catalog/"],
      ["v2.1.0", "index/a.astro", "/catalog/"],
      // A pin without a readable major takes the current rule.
      ["06308c8", "types/a.astro", "/"],
      ["v1.0.0", "types/a.astro", "/shell/catalog/"],
    ])
      expect(preset(pin!, page!).designSystem).toBe(`http://127.0.0.1:4998${path}`);
  });

  test("reads at HEAD, not the working tree", () => {
    const repo = repoFrom("spoke");
    Bun.write(
      join(repo, "docs/agent-work/items/uncommitted.md"),
      readFileSync(join(FIX, "spoke/docs/agent-work/items/check-the-copy.md")),
    );
    expect(readRepo(repo).items.map((i) => i.id)).not.toContain("uncommitted");
  });
});

describe("pages", () => {
  test("build pages that open from disk", async () => {
    const repo = repoFrom("spoke");
    const out = join(dirname(repo), "out");
    // A second repo without catalog or products, for the switcher's fallbacks.
    const plain = repoFrom("legacy", "plain");
    await buildSite(siteData([readRepo(repo), readRepo(plain)]), out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("Which variant ships?");
    const pages = readdirSync(join(out, "spoke"), { recursive: true }) as string[];
    expect(pages).toContain("decisions.html");
    expect(pages).toContain("products-1.html");
    expect(pages).toContain("doc/docs/agent-work/2026-01-15-sample-topic.html");
    for (const page of [
      "index.html",
      "spoke/decisions.html",
      "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html",
    ]) {
      const text = readFileSync(join(out, page), "utf8");
      // Every script is a classic file script: no module, which a page from disk cannot load, and
      // nothing inline, which admin-serve's script-src 'self' refuses.
      expect(text).toMatch(/<script src=/);
      for (const [tag] of text.matchAll(/<script[^>]*>/g))
        expect(tag).toMatch(/^<script src="[^"]+">$/);
      expect(text).not.toContain('"/_astro/');
      for (const [, ref] of text.matchAll(/(?:href|src)="([^"]*_astro\/[^"]+)"/g))
        expect(existsSync(resolve(dirname(join(out, page)), ref!))).toBe(true);
    }
    const docPath = join(out, "spoke/doc/docs/agent-work/2026-01-15-sample-topic.html");
    const doc = readFileSync(docPath, "utf8");
    // brand's prose block sets the article; its tables, quotes and code blocks stay hw-* elements.
    expect(doc).toContain('<article class="prose hw-prose');
    for (const el of ["hw-table", "hw-quote", "hw-code"])
      expect(doc).toContain(`class="${el} not-prose"`);
    // A link stays in the block, which draws it as the link in text.
    expect(doc).toContain('<a class="hw-link" href=');
    expect(doc).not.toMatch(/<a [^>]*not-prose/);
    // The title shows above the article, so the article opens on what follows it.
    expect(doc).toMatch(/<article[^>]*><p>A report/);
    const sheets = [...doc.matchAll(/href="([^"]+\.css)"/g)]
      .map(([, css]) => readFileSync(resolve(dirname(docPath), css!), "utf8"))
      .join("");
    // Typography's plugin is loaded: without it, prose styles nothing.
    expect(sheets).toContain(".prose :where(p)");
    expect(doc).toContain(`file://${repo}/docs/agent-work/2026-01-15-sample-topic/variant-a.svg`);
    // The top bar leads back to the hub. Its switcher keeps the current repo on its page and opens
    // another on the same page, on its Docs from a doc, else on its dashboard.
    const where = (html: string) => html.match(/<nav[^>]*aria-label="Where"[\s\S]*?<\/nav>/)![0];
    const repos = (html: string) => html.match(/<ul id="admin-repos"[\s\S]*?<\/ul>/)![0];
    expect(where(doc)).toContain('href="../../../../index.html"');
    expect(repos(doc)).toContain('href="../../../../plain/docs.html"');
    const decisions = readFileSync(join(out, "spoke/decisions.html"), "utf8");
    expect(repos(decisions)).toContain('href="decisions.html"');
    expect(repos(html)).toContain('href="spoke/dashboard.html"');
    expect(repos(decisions)).toContain('href="../plain/decisions.html"');
    // Astro drops a line break next to a tag: the pill keeps an explicit space before its label.
    expect(decisions).toMatch(/Recommended\s*<\/span>\s+<b>/);
    for (const [from, to] of [
      ["spoke/catalog.html", "../plain/dashboard.html"],
      ["spoke/products-1.html", "../plain/dashboard.html"],
      ["spoke/products-1.html", 'href="products-1.html"'],
    ])
      expect(repos(readFileSync(join(out, from!), "utf8"))).toContain(to!);
  }, 60_000);
});

describe("serve", () => {
  test("serves committed pages and files, rebuilding only after a commit", async () => {
    const repo = repoFrom("spoke");
    const hub = createHub({ root: dirname(repo) });
    const get = (path: string) => hub.fetch(new Request(`http://admin.localhost${path}`));
    const first = await (await get("/")).text();
    expect(first).toContain("Which variant ships?");
    expect(first).not.toContain("file://");
    expect(first).toContain("/_file/spoke/docs/agent-work/");
    const decisions = await get("/spoke/decisions");
    expect(decisions.status).toBe(200);
    expect(decisions.headers.get("content-security-policy")).toBe(CSP);
    expect(CSP).toMatch(/(^|; )script-src 'self'(;|$)/);
    const svg = await get("/_file/spoke/docs/agent-work/2026-01-15-sample-topic/variant-a.svg");
    expect(svg.headers.get("content-type")).toContain("image/svg");
    expect((await get("/_file/spoke/../../etc/passwd")).status).toBe(404);
    // node_modules, which no commit holds, answers from the installed package.
    Bun.spawnSync(["mkdir", "-p", join(repo, "node_modules/pkg")]);
    writeFileSync(join(repo, "node_modules/pkg/tokens.css"), ":root{}");
    expect(await (await get("/_file/spoke/node_modules/pkg/tokens.css")).text()).toBe(":root{}");
    // A symlink there leaving the repository reads nothing.
    const outside = scratch();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(repo, "node_modules/escape"));
    symlinkSync(join(outside, "secret.txt"), join(repo, "node_modules/pkg/secret.txt"));
    expect((await get("/_file/spoke/node_modules/escape/secret.txt")).status).toBe(404);
    expect((await get("/_file/spoke/node_modules/pkg/secret.txt")).status).toBe(404);
    expect((await hub.fetch(new Request("http://evil.example/"))).status).toBe(403);
    // A Git LFS pointer is answered with the object from the local LFS store.
    const oid = "ab".repeat(32);
    const store = join(repo, ".git/lfs/objects/ab/ab");
    Bun.spawnSync(["mkdir", "-p", store]);
    writeFileSync(join(store, oid), "<svg>stored</svg>");
    writeFileSync(
      join(repo, "docs/agent-work/lfs.svg"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 17\n`,
    );
    sh(repo, "git", "add", "docs/agent-work/lfs.svg");
    sh(
      repo,
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "l",
    );
    expect(await (await get("/_file/spoke/docs/agent-work/lfs.svg")).text()).toBe(
      "<svg>stored</svg>",
    );
    // Uncommitted work changes nothing; a commit does.
    const item = join(repo, "docs/agent-work/items/check-the-copy.md");
    writeFileSync(item, readFileSync(item, "utf8").replace("# ", "# Renamed "));
    const cached = await hub.pages();
    expect(await hub.pages()).toBe(cached);
    sh(
      repo,
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qam",
      "r",
    );
    expect(await hub.pages()).not.toBe(cached);
    expect(await (await get("/")).text()).toContain("Renamed ");
  }, 60_000);
});
