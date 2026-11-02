import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSite, siteData } from "../src/build.ts";
import { findRepos } from "../src/hub.ts";
import { itemDefects, parseItem, serializeItem, type Item } from "../src/items.ts";
import { decidedBy, migrate, readGoal, titleOf } from "../src/migrate.ts";
import { gitEnv, readItems, readRepo, treeSource } from "../src/repo.ts";
import { createHub } from "../src/serve.ts";

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
  test("serialize and parse round-trip", () => {
    const back = parseItem(valid.id, serializeItem(valid));
    expect(back).toEqual(valid);
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
      "image docs/tracking/items/a-question/y.jpg not found",
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
    Bun.write(join(dir, "docs/tracking/items/broken.md"), "no frontmatter\n");
    const { defects } = readItems(treeSource(dir));
    expect(defects).toContain("GOAL.md: legacy file, items live in docs/tracking/items");
    expect(defects).toContain("docs/tracking/items/broken.md: no frontmatter between --- lines");
    Bun.write(join(dir, "docs/tracking/items/gone/shot.jpg"), "x");
    expect(readItems(treeSource(dir)).defects).toContain(
      "docs/tracking/items/gone/shot.jpg: no item gone.md",
    );
    const cli = Bun.spawnSync(["bun", join(import.meta.dir, "../bin/admin-check.ts"), dir]);
    expect(cli.exitCode).toBe(1);
  });
});

describe("migration", () => {
  test("decidedBy reads the name before a date", () => {
    expect(decidedBy("Sam 02.01.: ship on Monday.")).toBe("Sam");
    expect(decidedBy("A Brief (Sam, 02.11.).")).toBe("Sam");
    expect(decidedBy("ship on Monday")).toBeUndefined();
  });

  test("titleOf keeps a short first sentence and cuts a long one", () => {
    expect(titleOf("Fix it. Then more.")).toBe("Fix it");
    expect(titleOf("word ".repeat(60)).length).toBeLessThanOrEqual(142);
  });

  test("readGoal takes open work rows only outside goal, done and waiting sections", () => {
    const { work, rest } = readGoal(readFileSync(join(FIX, "legacy/GOAL.md"), "utf8"), true);
    expect(work.map((w) => w.owner)).toEqual(["P1 2026-01-20 Alex", "P3 an agent"]);
    expect(rest).toContain("| tools | allowed |");
    expect(rest).toContain("Nothing here becomes work.");
  });

  test("readGoal takes a prioritised row before the first section, never a permissions table", () => {
    const text =
      "# Goal\n\n| Work | Owner | Evidence |\n| --- | --- | --- |\n| Tidy the logos | P3, a session | file |\n\n| Repo | Push |\n| --- | --- |\n| tools | allowed |\n";
    const { work, rest } = readGoal(text, true);
    expect(work).toEqual([{ point: "Tidy the logos", owner: "P3, a session", evidence: "file" }]);
    expect(rest).toContain("| tools | allowed |");
  });

  test("converts items.js, GOAL.md and a review folder into checked item files", () => {
    const dir = join(scratch(), "legacy");
    cpSync(join(FIX, "legacy"), dir, { recursive: true });
    const m = migrate(dir, { defaultOwner: "Alex", reviews: join(FIX, "reviews") });
    expect(m.removed.sort()).toEqual(["GOAL.md", "docs/tracking/decisions/items.js"]);
    const read = (id: string) =>
      parseItem(id, readFileSync(join(dir, `docs/tracking/items/${id}.md`), "utf8"));
    expect(read("pick-a-name")).toMatchObject({
      kind: "decision",
      owner: "Alex",
      order: 3,
      recommended: "a",
    });
    expect(read("pick-a-name").images).toEqual(["shot.svg"]);
    expect(existsSync(join(dir, "docs/tracking/items/pick-a-name/shot.svg"))).toBe(true);
    expect(existsSync(join(dir, "docs/tracking/items/pick-a-name/index.html"))).toBe(false);
    expect(read("look-at-logo")).toMatchObject({ kind: "review", owner: "Sam", priority: 1 });
    expect(read("colour-default").body).toContain("Measured on two screens.");
    expect(read("colour-default").body).toContain("source: a stray field");
    expect(read("ship-date")).toMatchObject({ status: "decided", by: "Sam" });
    expect(read("work-write-the-readme-for-the-tool")).toMatchObject({
      kind: "work",
      priority: 1,
      due: "2026-01-20",
      owner: "Alex",
    });
    expect(read("work-fix-the-flaky-test-in-the-build")).toMatchObject({
      priority: 3,
      evidence: "run 42.",
    });
    expect(read("goal").body).toContain("| tools | allowed |");
    expect(readItems(treeSource(dir)).defects).toEqual([]);
  });

  test("a dry run writes nothing", () => {
    const dir = join(scratch(), "legacy");
    cpSync(join(FIX, "legacy"), dir, { recursive: true });
    migrate(dir, { defaultOwner: "Alex", dryRun: true });
    expect(existsSync(join(dir, "docs/tracking/items"))).toBe(false);
    expect(existsSync(join(dir, "GOAL.md"))).toBe(true);
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
    // scaffolding's catalog preset is Astrobook at /catalog, started by the `catalog` script.
    const shell = readRepo(
      bare(
        "shell",
        { name: "shell", scripts: { dev: "wrangler dev", catalog: "cd catalog && astro dev" } },
        {
          "catalog/astro.config.ts":
            'import { catalog } from "@hackersandwizards/scaffolding/catalog";\nserver: { host: "127.0.0.1", port: 4998 }',
        },
      ),
    );
    expect(shell.designSystem).toBe("http://127.0.0.1:4998/catalog/");
    expect(shell.designSystemDev).toEqual({ port: 4998, start: "catalog" });
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

  test("reads at HEAD, not the working tree", () => {
    const repo = repoFrom("spoke");
    Bun.write(
      join(repo, "docs/tracking/items/uncommitted.md"),
      readFileSync(join(FIX, "spoke/docs/tracking/items/check-the-copy.md")),
    );
    expect(readRepo(repo).items.map((i) => i.id)).not.toContain("uncommitted");
  });
});

describe("pages", () => {
  test("build pages that open from disk", async () => {
    const repo = repoFrom("spoke");
    const out = join(dirname(repo), "out");
    await buildSite(siteData([readRepo(repo)], true), out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("Which variant ships?");
    const pages = readdirSync(join(out, "spoke"), { recursive: true }) as string[];
    expect(pages).toContain("decisions.html");
    expect(pages).toContain("products-1.html");
    expect(pages).toContain("doc/docs/tracking/2026-01-15-sample-topic.html");
    for (const page of [
      "index.html",
      "spoke/decisions.html",
      "spoke/doc/docs/tracking/2026-01-15-sample-topic.html",
    ]) {
      const text = readFileSync(join(out, page), "utf8");
      expect(text).not.toMatch(/<script[^>]+src=/);
      expect(text).not.toContain('"/_astro/');
      for (const [, ref] of text.matchAll(/(?:href|src)="([^"]*_astro\/[^"]+)"/g))
        expect(existsSync(resolve(dirname(join(out, page)), ref!))).toBe(true);
    }
    const doc = readFileSync(
      join(out, "spoke/doc/docs/tracking/2026-01-15-sample-topic.html"),
      "utf8",
    );
    expect(doc).toContain('class="hw-table"');
    expect(doc).toContain(`file://${repo}/docs/tracking/2026-01-15-sample-topic/variant-a.svg`);
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
    expect(first).toContain("/_file/spoke/docs/tracking/");
    expect((await get("/spoke/decisions")).status).toBe(200);
    const svg = await get("/_file/spoke/docs/tracking/2026-01-15-sample-topic/variant-a.svg");
    expect(svg.headers.get("content-type")).toContain("image/svg");
    expect((await get("/_file/spoke/../../etc/passwd")).status).toBe(404);
    // node_modules, which no commit holds, answers from the installed package.
    Bun.spawnSync(["mkdir", "-p", join(repo, "node_modules/pkg")]);
    writeFileSync(join(repo, "node_modules/pkg/tokens.css"), ":root{}");
    expect(await (await get("/_file/spoke/node_modules/pkg/tokens.css")).text()).toBe(":root{}");
    expect((await hub.fetch(new Request("http://evil.example/"))).status).toBe(403);
    // A Git LFS pointer is answered with the object from the local LFS store.
    const oid = "ab".repeat(32);
    const store = join(repo, ".git/lfs/objects/ab/ab");
    Bun.spawnSync(["mkdir", "-p", store]);
    writeFileSync(join(store, oid), "<svg>stored</svg>");
    writeFileSync(
      join(repo, "docs/tracking/lfs.svg"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 17\n`,
    );
    sh(repo, "git", "add", "docs/tracking/lfs.svg");
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
    expect(await (await get("/_file/spoke/docs/tracking/lfs.svg")).text()).toBe(
      "<svg>stored</svg>",
    );
    // Uncommitted work changes nothing; a commit does.
    const item = join(repo, "docs/tracking/items/check-the-copy.md");
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
