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
import { peerDependenciesMeta } from "../package.json";
import { buildSite, PAGE_TYPES, siteData } from "../src/build.ts";
import { findRepos } from "../src/hub.ts";
import { itemDefects, parseItem, type Item } from "../src/items.ts";
import { gitEnv, readItems, readRepo, renderMarkdown, treeSource } from "../src/repo.ts";
import { createHub, csp } from "../src/serve.ts";

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
const commit = (cwd: string, message: string) =>
  sh(
    cwd,
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    message,
  );
function repoFrom(fixture: string, name = "spoke") {
  const dir = join(scratch(), name);
  cpSync(join(FIX, fixture), dir, { recursive: true });
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "add", "-A");
  commit(dir, "c");
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
      "name-the-command",
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
    const repo = await readRepo(dir, treeSource(dir));
    expect(repo.defects.join("\n")).toContain("odd.md: options is not a list");
    const out = join(scratch(), "out");
    await buildSite(siteData([repo]), out);
    expect(readFileSync(join(out, "r/decisions.html"), "utf8")).toContain("Odd");
  });

  test("a stray % in a Markdown link stays as written", () => {
    expect(renderMarkdown("/r", "docs/a.md", "[half](50%.md)")).toContain("docs/50%25.md");
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
      renderMarkdown("/r", "docs/a.md", body),
      siteData([repo]).repos[0]!.items[0]!.html,
    ]) {
      expect(html).not.toMatch(/<meta/i);
      expect(html).toContain("&lt;meta http-equiv=");
    }
  });

  test("a task list wears no marker beside its read-only hw-check boxes", () => {
    const html = renderMarkdown("/r", "docs/a.md", "- [ ] open\n- [x] done\n\nNext:\n\n- plain\n");
    expect(html.match(/hw-marker-list/g)).toHaveLength(1);
    expect(html).toContain('<ul>\n<li class="task-list-item">');
    expect(
      html.match(/class="task-list-item-checkbox hw-check" data-readonly disabled/g),
    ).toHaveLength(2);
  });
});

describe("hub", () => {
  test("finds each repo with committed items once, skipping dot folders", async () => {
    const repo = repoFrom("spoke");
    const root = dirname(repo);
    sh(root, "git", "clone", "-q", repo, join(root, ".hidden"));
    expect(await findRepos(root)).toEqual([repo]);
  });

  test("finds a repo naming an @hackersandwizards package with no items, and none other", async () => {
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
      commit(dir, "c");
      return dir;
    };
    const tool = bare("tool", { name: "@hackersandwizards/tool" });
    bare("other", { name: "other" });
    expect(await findRepos(root)).toEqual([repo, tool]);
    expect((await readRepo(tool)).designSystem).toBeUndefined();
    expect(
      (await readRepo(bare("ui", { name: "ui", devDependencies: { astro: "1" } }))).designSystem,
    ).toBe(undefined);
    const book = await readRepo(
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
    const owned = await readRepo(
      bare("owned", {
        name: "owned",
        admin: { designSystem: "catalogue.html", products: [{ label: "A", href: "a.html#x" }] },
      }),
    );
    expect(owned.designSystem).toBe(`file://${owned.path}/catalogue.html`);
    expect(owned.designSystemDev).toBeUndefined();
    expect(owned.products[0]!.href).toBe(`file://${owned.path}/a.html#x`);
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

  test("reads at HEAD, not the working tree", async () => {
    const repo = repoFrom("spoke");
    Bun.write(
      join(repo, "docs/agent-work/items/uncommitted.md"),
      readFileSync(join(FIX, "spoke/docs/agent-work/items/check-the-copy.md")),
    );
    expect((await readRepo(repo)).items.map((i) => i.id)).not.toContain("uncommitted");
  });
});

describe("pages", () => {
  test("build pages that open from disk", async () => {
    const repo = repoFrom("spoke");
    const out = join(dirname(repo), "out");
    // A second repo without catalog or products, for the switcher's fallbacks.
    const plain = repoFrom("legacy", "plain");
    await buildSite(siteData([await readRepo(repo), await readRepo(plain)]), out);
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
    expect(doc).toContain('<article class="prose hw-prose');
    for (const el of ["hw-table", "hw-quote", "hw-code"])
      expect(doc).toContain(`class="${el} not-prose"`);
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
    const where = (html: string) => html.match(/<nav[^>]*aria-label="Where"[\s\S]*?<\/nav>/)![0];
    const repos = (html: string) => html.match(/<div id="admin-repos"[\s\S]*?<\/div>/)![0];
    expect(where(doc)).toContain('href="../../../../index.html"');
    expect(repos(doc)).toContain('href="../../../../plain/docs.html"');
    const decisions = readFileSync(join(out, "spoke/decisions.html"), "utf8");
    // brand's element script reaches the page as one classic script, which a page from disk loads.
    const [, script] = decisions.match(/<script src="([^"]*admin[^"]*\.js)"/)!;
    const bundled = readFileSync(resolve(out, "spoke", script!), "utf8");
    expect(bundled).toContain("hw-menu");
    expect(bundled).not.toMatch(/^import\b/m);
    expect(repos(decisions)).toContain('href="decisions.html"');
    expect(repos(html)).toContain('href="spoke/dashboard.html"');
    expect(repos(decisions)).toContain('href="../plain/decisions.html"');
    // Answers given on a repo page are copied there, not on a trip back to the hub.
    for (const page of ["dashboard", "work", "reviews"])
      expect(readFileSync(join(out, `spoke/${page}.html`), "utf8")).toContain('id="copy"');
    // brand's enhance() wires the Copy button by its data-hw-copy attribute.
    expect(decisions).toMatch(/id="copy"[^>]*data-hw-copy/);
    expect(bundled).toContain("[data-hw-copy]");
    // The copy time is set from brand's hw-copy event, which says whether the copy worked.
    expect(readFileSync(join(import.meta.dir, "../site/src/admin.js"), "utf8")).toMatch(
      /addEventListener\("hw-copy"[\s\S]*?if \(!e\.detail\?\.ok\) return;/,
    );
    // Astro drops a line break next to a tag: the pill keeps an explicit space before its label.
    expect(decisions).toMatch(/Recommended\s*<\/span>\s+<b>/);
    for (const [from, to] of [
      ["spoke/catalog.html", "../plain/dashboard.html"],
      ["spoke/products-1.html", "../plain/dashboard.html"],
      ["spoke/products-1.html", 'href="products-1.html"'],
    ])
      expect(repos(readFileSync(join(out, from!), "utf8"))).toContain(to!);
  }, 60_000);
  test("leaving a page asks nothing: answers are stored as they are typed", () => {
    const script = readFileSync(join(import.meta.dir, "../site/src/admin.js"), "utf8");
    expect(script).not.toMatch(/beforeunload/);
  });
});

describe("serve", () => {
  test("a repository that never serves the hub installs no Tailwind for it", () => {
    // admin-serve stops and names a missing optional peer, so only a repository that serves pins it.
    for (const p of ["tailwindcss", "@tailwindcss/vite", "@tailwindcss/typography"])
      expect(peerDependenciesMeta).toHaveProperty([p, "optional"], true);
  });

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
    expect(decisions.headers.get("content-security-policy")).toBe(csp("http://admin.localhost"));
    expect(csp("http://admin.localhost")).toMatch(
      /(^|; )script-src http:\/\/admin\.localhost\/_astro\/(;|$)/,
    );
    // A committed form posts nowhere else, and no outside page is framed into the hub.
    expect(csp("http://admin.localhost")).toMatch(/(^|; )form-action 'self'(;|$)/);
    expect(csp("http://admin.localhost")).toMatch(/(^|; )frame-src 'self'(;|$)/);
    for (const bare of ["/spoke", "/spoke/?who=A"]) {
      const r = await get(bare);
      expect([r.status, r.headers.get("location")]).toEqual([
        302,
        `http://admin.localhost/spoke/dashboard${bare.slice(6).replace(/^\//, "")}`,
      ]);
    }
    expect((await get("/nosuchrepo/")).status).toBe(404);
    // Every script, on the hub and on a nested page, resolves under the one path the policy runs.
    const nested = await decisions.text();
    // A page travels gzipped where the browser takes it, and a hashed asset stays in its cache.
    const zipped = await hub.fetch(
      new Request("http://admin.localhost/spoke/decisions", {
        headers: { "accept-encoding": "gzip, br" },
      }),
    );
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(new TextDecoder().decode(Bun.gunzipSync(await zipped.bytes()))).toBe(nested);
    const css = first.match(/href="\.\/(_astro\/[^"]+\.css)"/)![1]!;
    expect((await get(`/${css}`)).headers.get("cache-control")).toContain("immutable");
    expect(decisions.headers.get("cache-control")).toBe("no-store");
    for (const [page, html] of [
      ["/", first],
      ["/spoke/decisions", nested],
    ] as const) {
      const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs)
        expect(new URL(src, `http://admin.localhost${page}`).pathname).toStartWith("/_astro/");
    }
    for (const query of ["", "?who=A"]) {
      const slash = await get(`/spoke/decisions/${query}`);
      expect([slash.status, slash.headers.get("location")]).toEqual([
        302,
        `http://admin.localhost/spoke/decisions${query}`,
      ]);
    }
    const svg = await get("/_file/spoke/docs/agent-work/2026-01-15-sample-topic/variant-a.svg");
    expect(svg.headers.get("content-type")).toContain("image/svg");
    writeFileSync(join(repo, "uncommitted.txt"), "uncommitted");
    expect((await get("/_file/spoke/node_modules/..%2Funcommitted.txt")).status).toBe(404);
    Bun.spawnSync(["mkdir", "-p", join(repo, "node_modules/pkg")]);
    writeFileSync(join(repo, "node_modules/pkg/tokens.css"), ":root{}");
    expect(await (await get("/_file/spoke/node_modules/pkg/tokens.css")).text()).toBe(":root{}");
    const outside = scratch();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(repo, "node_modules/escape"));
    symlinkSync(join(outside, "secret.txt"), join(repo, "node_modules/pkg/secret.txt"));
    expect((await get("/_file/spoke/node_modules/escape/secret.txt")).status).toBe(404);
    expect((await get("/_file/spoke/node_modules/pkg/secret.txt")).status).toBe(404);
    expect((await hub.fetch(new Request("http://evil.example/"))).status).toBe(403);
    const oid = "ab".repeat(32);
    const store = join(repo, ".git/lfs/objects/ab/ab");
    Bun.spawnSync(["mkdir", "-p", store]);
    writeFileSync(join(store, oid), "<svg>stored</svg>");
    writeFileSync(
      join(repo, "docs/agent-work/lfs.svg"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 17\n`,
    );
    sh(repo, "git", "add", "docs/agent-work/lfs.svg");
    commit(repo, "l");
    expect(await (await get("/_file/spoke/docs/agent-work/lfs.svg")).text()).toBe(
      "<svg>stored</svg>",
    );
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

describe("catalog", () => {
  const stories = join(import.meta.dir, "../catalog/stories");
  const storyText = (readdirSync(stories, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".stories.ts"))
    .map((f) => readFileSync(join(stories, f), "utf8"))
    .join("\n");

  test("every component and every page type has a story", () => {
    const components = readdirSync(join(import.meta.dir, "../site/src/components"));
    expect(components.length).toBeGreaterThan(0);
    for (const c of components) expect(storyText).toContain(`/site/src/components/${c}"`);
    for (const t of PAGE_TYPES) expect(storyText).toContain(`page("${t}")`);
  });

  test("the hub serves a committed image at a thumbnail's width", async () => {
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const png = (w: number, h: number) => new Bun.Image(pixel).resize(w, h).png().bytes();
    const repo = repoFrom("spoke");
    const dir = join(repo, "docs/agent-work/2026-01-15-sample-topic");
    writeFileSync(join(dir, "wide.png"), await png(2000, 1000));
    writeFileSync(join(dir, "tall.png"), await png(400, 2000));
    writeFileSync(join(dir, "small.png"), await png(100, 100));
    writeFileSync(join(dir, "broken.png"), "no image");
    sh(repo, "git", "add", "-A");
    commit(repo, "i");
    const hub = createHub({ root: dirname(repo) });
    const page = await (
      await hub.fetch(new Request("http://admin.localhost/spoke/reviews"))
    ).text();
    const img = page.match(/<img[^>]*small\.png[^>]*>/)![0];
    const at = "/_file/spoke/docs/agent-work/2026-01-15-sample-topic";
    expect(img).toContain(`src="${at}/small.png?w=480"`);
    expect(img).toContain(`srcset="${at}/small.png?w=480 480w, ${at}/small.png?w=960 960w"`);
    const get = (q: string, headers = {}) =>
      hub.fetch(new Request(`http://admin.localhost${at}/${q}`, { headers }));
    const small = await get("wide.png?w=480");
    expect(small.headers.get("content-type")).toBe("image/webp");
    expect((await new Bun.Image(await small.bytes()).metadata()).width).toBe(480);
    const tall = await new Bun.Image(await (await get("tall.png?w=480")).bytes()).metadata();
    expect([tall.width, tall.height]).toEqual([54, 270]);
    // The full file: no width, a width the hub does not offer, or an image that already fits.
    for (const q of ["wide.png", "wide.png?w=123", "small.png?w=480", "broken.png?w=480"])
      expect((await get(q)).headers.get("content-type")).toBe("image/png");
    const repeat = await get("wide.png?w=480", { "if-none-match": small.headers.get("etag")! });
    expect(repeat.status).toBe(304);
    expect((await get("wide.png?w=960")).headers.get("etag")).not.toBe(small.headers.get("etag"));
  }, 60_000);

  test("the hub serves the catalog at /catalog/ and links it", async () => {
    const hub = createHub({ root: dirname(repoFrom("spoke")) });
    const get = (path: string) => hub.fetch(new Request(`http://admin.localhost${path}`));
    const hubPage = await get("/");
    expect(hubPage.status).toBe(200);
    expect(await hubPage.text()).toMatch(/<a href="\/catalog\/"[^>]*>\s*Catalog\s*</);
    const bare = await get("/catalog");
    expect([bare.status, bare.headers.get("location")]).toEqual([
      302,
      "http://admin.localhost/catalog/",
    ]);
    const home = await get("/catalog/");
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Every page and component of the admin engine");
    const sheet = html.match(/href="(\/catalog\/_astro\/[^"]+\.css)"/)![1]!;
    expect((await get(sheet)).headers.get("cache-control")).toContain("immutable");
    const story = await get("/catalog/stories/Items/shot/captioned");
    expect(story.status).toBe(200);
    const src = (await story.text()).match(/<img[^>]*src="([^"]+)"/)![1]!;
    expect(src).toStartWith("/catalog/test/fixtures/spoke/");
    expect((await get(src)).headers.get("content-type")).toContain("image/svg");
    expect((await get("/catalog/no-such-page")).status).toBe(404);
  }, 60_000);
});
