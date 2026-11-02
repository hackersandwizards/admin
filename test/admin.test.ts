import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSite, siteData } from "../src/build.ts";
import { findRepos } from "../src/hub.ts";
import { itemDefects, parseItem, serializeItem, type Item } from "../src/items.ts";
import { decidedBy, migrate, readGoal, titleOf } from "../src/migrate.ts";
import { gitEnv, readItems, readRepo, treeSource } from "../src/repo.ts";

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
  ] as [Partial<Item>, string][])("defect %#: %p", (change, message) => {
    const defects = itemDefects({ ...valid, ...change } as Item, exists);
    expect(defects.join("\n")).toContain(message);
  });

  test("a missing image or page is a defect", () => {
    const item = { ...valid, images: { a: "docs/x.jpg" }, page: "docs/p/index.html" };
    expect(itemDefects(item, () => false)).toEqual([
      "image docs/x.jpg not found",
      "page docs/p/index.html not found",
    ]);
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
      "pick-a-variant",
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
    expect(read("pick-a-name").page).toMatch(
      /^docs\/tracking\/\d{4}-\d{2}-\d{2}-sample-topic\/index\.html$/,
    );
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
