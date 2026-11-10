import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { peerDependenciesMeta } from "../package.json";
import {
  Window,
  type HTMLElement as DomElement,
  type HTMLInputElement as DomInput,
} from "happy-dom";
import { buildSite, PAGE_TYPES, script, siteData } from "../src/build.ts";
import { findRepos } from "../src/hub.ts";
import {
  compareItems,
  DUE_SOON_DAYS,
  dueSoon,
  itemDefects,
  parseItem,
  usable,
  type Item,
} from "../src/items.ts";
import {
  fetchedAt,
  gitEnv,
  readItems,
  readRepo,
  renderMarkdown,
  treeSource,
  when,
} from "../src/repo.ts";
import { createHub, csp, linker } from "../src/serve.ts";
import { dueOf, inline, withLinks } from "../site/src/data.ts";

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
  test("within a priority order ranks, and a due date leads only within a week", () => {
    const day = 864e5;
    const at = (n: number) => new Date(Date.now() + n * day).toISOString().slice(0, 10);
    const ranked = { ...valid, id: "ranked", order: 10 };
    const far = { ...valid, id: "far", order: 20, due: at(30) };
    const near = { ...valid, id: "near", order: 30, due: at(DUE_SOON_DAYS - 1) };
    const late = { ...valid, id: "late", order: 40, due: at(-2) };
    expect([near, far, ranked, late].sort(compareItems).map((i) => i.id)).toEqual([
      "late",
      "near",
      "ranked",
      "far",
    ]);
  });

  test("a due date comes within a week by local day, also just after midnight", () => {
    // East of UTC, half past midnight is still the day before in UTC.
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      const night = new Date();
      night.setHours(0, 30, 0, 0);
      const local = (n: number) => {
        const d = new Date(night);
        d.setDate(d.getDate() + n);
        return d.toLocaleDateString("sv-SE");
      };
      expect(dueSoon(local(DUE_SOON_DAYS), night.getTime())).toBe(true);
      expect(dueSoon(local(DUE_SOON_DAYS + 1), night.getTime())).toBe(false);
    } finally {
      process.env.TZ = tz;
    }
  });

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

  test("a field the pages print as text, a day and an option key are checked as such", () => {
    const defects = (more: object) => itemDefects({ ...valid, ...more } as Item, exists);
    expect(defects({ due: "2026-13-45" })).toContain("due 2026-13-45 not ISO");
    expect(defects({ due: "2028-02-29" })).toEqual([]);
    expect(defects({ area: { a: 1 } })).toContain("area is not text");
    const options = (a: object) => ({
      options: [
        { key: "a", label: "A", ...a },
        { key: "b", label: "B" },
      ],
    });
    expect(defects(options({ label: { l: 1 } }))).toContain("option a label or detail is not text");
    expect(defects({ ...options({ key: "a,b" }), recommended: "b" })).toContain(
      'option 1 key "a,b" is not one word',
    );
    // A numeric key is the key an images mapping names, 0 included.
    const numbered = {
      options: [
        { key: 0, label: "Zero" },
        { key: 1, label: "One" },
      ],
      recommended: 1,
    };
    expect(defects({ ...numbered, images: { 0: "a.png", 1: "b.png" } })).toEqual([]);
    const shown = usable({
      ...valid,
      ...numbered,
      area: { a: 1 },
      due: "2026-13-45",
    } as unknown as Item);
    expect([shown.area, shown.due, shown.options!.map((o) => o.key), shown.recommended]).toEqual([
      undefined,
      undefined,
      ["0", "1"],
      ["1"],
    ]);
    // An image names a file: a folder of that name is no image.
    const { defects: found } = readItems({
      paths: ["docs/agent-work/items/shot.md", "docs/agent-work/2026-01-01-r/a.png"],
      read: () =>
        "---\nkind: review\nstatus: open\npriority: 2\nowner: Alex\nimages: [docs/agent-work/2026-01-01-r]\n---\n# Shot\n",
    });
    expect(found).toEqual([
      "docs/agent-work/items/shot.md: image docs/agent-work/2026-01-01-r not found",
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
      "ask-the-printer",
      "cache-folder",
      "check-the-copy",
      "goal",
      "name-the-command",
      "pick-a-logo",
      "pick-a-variant",
      "pick-recipients",
      "sort-the-samples",
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

  test("an item's paths link into the repository named beside them, or stay text", async () => {
    const spoke = await readRepo(join(FIX, "spoke"), treeSource(join(FIX, "spoke")));
    const body = [
      "Report: other `docs/agent-work/notes.md`.",
      "Old: `git show abc~1:docs/agent-work/gone.md` in other.",
      "Own: docs/agent-work/2026-01-15-sample-topic.md, none: docs/agent-work/missing.md.",
      "[relative](../2026-01-15-sample-topic.md)",
      "Folder: docs/agent-work/2026-01-15-sample-topic, item: docs/agent-work/items/goal.md.",
      "![shot of docs/agent-work/2026-01-15-sample-topic.md](a.png)",
    ].join("\n\n");
    const item = parseItem(
      "x",
      `---\nkind: work\nstatus: open\npriority: 1\nowner: A\n---\n# X\n\n${body}\n`,
    );
    const other = {
      ...spoke,
      key: "other",
      path: "/o/other",
      items: [],
      workFiles: ["docs/agent-work/notes.md"],
    };
    const html = siteData([{ ...spoke, items: [item] }, other]).repos[0]!.items[0]!.html;
    const at = (path: string) => `href="file://${path}"`;
    expect(html).toContain(at("/o/other/docs/agent-work/notes.md"));
    expect(html).not.toContain('gone.md"');
    expect(html).toContain(at(`${spoke.path}/docs/agent-work/2026-01-15-sample-topic.md`));
    expect(html).not.toContain('missing.md"');
    expect(html).toMatch(
      new RegExp(`${at(`${spoke.path}/docs/agent-work/2026-01-15-sample-topic.md`)}>relative<`),
    );
    expect(html).not.toContain('href="../');
    // A folder has no file to serve; an item file has.
    expect(html).not.toContain('sample-topic"');
    expect(html).toContain(at(`${spoke.path}/docs/agent-work/items/goal.md`));
    // A path inside an attribute stays text, so the tag holds.
    expect(html).toContain('alt="shot of docs/agent-work/2026-01-15-sample-topic.md"');
    // A body has no front matter: a leading rule stays, with the text after it.
    const ruled = { ...item, id: "ruled", body: "---\nKept.\n\n---\nAfter." };
    const unowned = { ...item, id: "unowned", owner: undefined };
    const [r, u] = siteData([{ ...spoke, items: [ruled, unowned] }]).repos[0]!.items;
    expect(r!.html).toContain("Kept.");
    expect(u!.agent).toBe(false);
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

  test("a doc's title is its first rendered h1, which leaves the article", async () => {
    const files: Record<string, string> = {
      "docs/fenced.md": "```sh\n# install deps\n```\n\n# Setup &amp; *run*\n\nBody.\n",
      "docs/setext.md": "Setext title\n============\n\nBody.\n",
      "docs/none.md": "Just text.\n",
      "docs/image.md": "# ![logo](logo.png)\n\nBody.\n",
    };
    const { docs } = await readRepo("/nonexistent/titles", {
      paths: Object.keys(files),
      read: (f) => files[f],
    });
    const by = Object.fromEntries(docs.map((d) => [d.path, d]));
    expect(by["docs/fenced.md"]!.title).toBe("Setup & run");
    expect(by["docs/fenced.md"]!.html).toContain("# install deps");
    expect(by["docs/setext.md"]!.title).toBe("Setext title");
    expect(by["docs/none.md"]!.title).toBe("docs/none.md");
    expect(by["docs/image.md"]!.title).toBe("docs/image.md");
    expect(by["docs/image.md"]!.html).toContain("<h1><img");
    for (const d of ["fenced", "setext"]) expect(by[`docs/${d}.md`]!.html).not.toContain("<h1");
  });

  test("reads a worktree's fetch, and a checkout without upstream as commits behind unknown", async () => {
    const repo = repoFrom("spoke");
    const tree = join(dirname(repo), "tree");
    sh(repo, "git", "worktree", "add", "-q", "--detach", tree);
    writeFileSync(
      resolve(tree, sh(tree, "git", "rev-parse", "--git-path", "FETCH_HEAD").trim()),
      "",
    );
    const read = await readRepo(tree);
    expect(read.fetched).toBeNumber();
    expect(read.behind).toBeUndefined();
  });

  test("a folder git cannot read has no fetch time, and is asked again once it can", async () => {
    const dir = scratch();
    expect(await fetchedAt(dir)).toBeUndefined();
    sh(dir, "git", "init", "-q");
    writeFileSync(join(dir, ".git/FETCH_HEAD"), "");
    expect(await fetchedAt(dir)).toBeNumber();
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

  test("front matter is a leading YAML mapping; a leading rule stays in the doc", () => {
    const html = (text: string) => renderMarkdown("/r", "docs/a.md", text);
    expect(html("---\n\nintro\n\n---\n\nrest\n")).toContain("intro");
    expect(html("---\ntitle: x\n---\n\nrest\n")).not.toContain("title");
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
    // A doc named index.md ends its page's path in "index", which Astro reads as the folder's own.
    mkdirSync(join(plain, "docs/guide"), { recursive: true });
    writeFileSync(join(plain, "docs/index.md"), "# Start here\n");
    writeFileSync(join(plain, "docs/guide/index.md"), "# Guide\n");
    sh(plain, "git", "add", "-A");
    commit(plain, "d");
    await buildSite(siteData([await readRepo(repo), await readRepo(plain)]), out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("Which variant ships?");
    // Waiting on others links a person's item to its row; an agent's item shows under its own
    // heading, collapsed, as a link to its row, and no person filter hides it.
    const waiting = html.slice(html.indexOf("Waiting on others"), html.indexOf("Agents on it"));
    expect(waiting).toContain('href="spoke/work.html#spoke:ask-the-printer"');
    expect(waiting).toContain('href="spoke/decisions.html#spoke:check-the-copy"');
    expect(html.indexOf("Sort the sample files")).toBeGreaterThan(html.indexOf("Agents on it"));
    const agents = html.slice(html.indexOf("Agents on it"), html.indexOf("Repositories"));
    expect(agents).not.toMatch(/<details[^>]*data-group[^>]* open/);
    expect(agents).toContain('href="spoke/work.html#spoke:sort-the-samples"');
    expect(agents).not.toContain("<textarea");
    expect(agents).not.toMatch(/<div[^>]*data-row[^>]*data-who/);
    // Settled items come last, after the repositories.
    expect(html.indexOf(">Settled</h2>")).toBeGreaterThan(html.indexOf(">Repositories</h2>"));
    expect(html.indexOf('id="spoke:name-the-command"')).toBeGreaterThan(
      html.indexOf(">Settled</h2>"),
    );
    expect(readFileSync(join(out, "spoke/dashboard.html"), "utf8")).toContain(
      "Sort the sample files",
    );
    // On a phone the repositories table keeps three columns; the most urgent item goes under the
    // repository's name.
    const table = html.slice(html.indexOf(">Repositories</h2>"));
    expect(
      table.slice(0, table.indexOf("</thead>")).match(/<th(?=[\s>])(?![^>]*max-sm:hidden)[^>]*>/g),
    ).toHaveLength(3);
    expect(readFileSync(join(out, "spoke/work.html"), "utf8")).toContain(
      'id="spoke:ask-the-printer"',
    );
    const pages = readdirSync(join(out, "spoke"), { recursive: true }) as string[];
    expect(pages).toContain("decisions.html");
    expect(pages).toContain("products-1.html");
    expect(pages).toContain("doc/docs/agent-work/2026-01-15-sample-topic.html");
    const plainDocs = readFileSync(join(out, "plain/docs.html"), "utf8");
    for (const [title, to] of [
      ["Start here", "doc/docs/index"],
      ["Guide", "doc/docs/guide/index"],
    ] as const) {
      const link = plainDocs.match(new RegExp(`href="([^"]+)">\\s*${title}`))![1]!;
      expect(link).toStartWith(to);
      expect(readFileSync(join(out, "plain", link), "utf8")).toContain(`<h1>${title}</h1>`);
    }
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
    expect(bundled).toMatch(/addEventListener\("hw-copy"[^]*?\.detail\?\.ok/);
    // The catalog marks its pages, so its fixture answers stay apart from the hub's.
    expect(bundled).toMatch(/"adminCatalog"\s*in\s*document\.documentElement\.dataset/);
    // Astro drops a line break next to a tag: the pill keeps an explicit space before its label.
    expect(decisions).toMatch(/Recommended\s*<\/span>\s+<b>/);
    for (const [from, to] of [
      ["spoke/catalog.html", "../plain/dashboard.html"],
      ["spoke/products-1.html", "../plain/dashboard.html"],
      ["spoke/products-1.html", 'href="products-1.html"'],
    ])
      expect(repos(readFileSync(join(out, from!), "utf8"))).toContain(to!);
  }, 60_000);
  test("the hub ranks every repository's rows in one order; Reviews lists review requests", async () => {
    const spoke = await readRepo(repoFrom("spoke"));
    const base = spoke.items.find((i) => i.id === "ask-the-printer")!;
    const late = { ...base, id: "late", owner: "Alex", order: 80 };
    const other = {
      ...spoke,
      key: "other",
      path: `${spoke.path}-other`,
      items: [{ ...base, id: "early", owner: "Alex", order: 20 }],
    };
    const out = join(scratch(), "out");
    await buildSite(siteData([{ ...spoke, items: [...spoke.items, late] }, other]), out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html.indexOf('id="other:early"')).toBeLessThan(html.indexOf('id="spoke:late"'));
    // Each row names its repository.
    expect(html).toMatch(/id="other:early"[\s\S]*?<\/summary>/);
    expect(html.match(/id="other:early"[\s\S]*?<\/summary>/)![0]).toContain("other · to do");
    const reviews = readFileSync(join(out, "spoke/reviews.html"), "utf8");
    for (const id of ["check-the-copy", "pick-recipients", "pick-a-variant"])
      expect(reviews).toContain(`id="spoke:${id}"`);
    for (const id of ["goal", "ask-the-printer"]) expect(reviews).not.toContain(`id="spoke:${id}"`);
    // A settled row says what was assumed or decided, never what was recommended.
    const settled = (id: string) =>
      html.match(new RegExp(`id="spoke:${id}"[\\s\\S]*?</summary>`))![0];
    expect(settled("cache-folder")).toContain("Assumed: The build writes to node_modules/.cache");
    expect(settled("name-the-command")).toContain("Decided by Alex: Keep the short name");
    expect(settled("name-the-command")).not.toContain("Recommended");
    // An opened decision shows its options before its context.
    const variant = html.match(/id="spoke:pick-a-variant"[\s\S]*?<\/details>/)![0];
    expect(variant.indexOf('value="a"')).toBeLessThan(variant.indexOf(">Context<"));
    expect(variant.indexOf("Pick recommended")).toBeLessThan(variant.indexOf(">Context<"));
    // The hub's provenance names the checkouts behind and says when it is from.
    expect(html).toMatch(/class="admin-provenance[^>]*>[^<]*· as of \d/);
    expect(html).toContain("Decide P2");
  }, 60_000);

  test("a due date says today or overdue, and a one-line field renders its code and links", () => {
    const now = new Date(2026, 10, 10, 12).getTime();
    expect(dueOf("2026-11-10", now)).toEqual({ text: "due today", tone: "today" });
    expect(dueOf("2026-11-03", now).tone).toBe("overdue");
    expect(dueOf("2026-11-03", now).text).toStartWith("was due 3 Nov");
    expect(dueOf("2026-11-13", now).tone).toBe("soon");
    expect(dueOf("2026-12-13", now).tone).toBe("later");
    expect(inline("use `a-b` & <i>, see http://127.0.0.1:4329/x.")).toBe(
      'use <code class="hw-inline-code">a-b</code> &amp; &lt;i&gt;, see <a class="hw-link" href="http://127.0.0.1:4329/x">http://127.0.0.1:4329/x</a>.',
    );
    // An address already linked, inside a tag or inside code stays as it is; quotes end one.
    const html =
      '<p><a href="http://a.example/">http://a.example/</a> <img src="http://b.example/i.png"> <code>curl http://c.example/y</code></p>';
    expect(withLinks(html)).toBe(html);
    expect(inline(`see "https://d.example/a" or 'https://d.example/b'`)).toBe(
      'see &quot;<a class="hw-link" href="https://d.example/a">https://d.example/a</a>&quot; or &#x27;<a class="hw-link" href="https://d.example/b">https://d.example/b</a>&#x27;',
    );
  });

  test("waiting on others: people other than the hub's user, never an agent", async () => {
    const repo = await readRepo(join(FIX, "spoke"), treeSource(join(FIX, "spoke")));
    expect(repo.agents).toEqual(["Ivo"]);
    // The first person stands for the hub's user when none is named.
    expect(siteData([repo]).others).toEqual(["Kim", "Sam"]);
    expect(siteData([repo], "Sam").others).toEqual(["Alex", "Kim"]);
    // The person filter starts on the hub's user, who comes first.
    expect(siteData([repo], "Sam").people[0]).toBe("Sam");
    // A git name no owner writes stands for nobody: the first person does.
    expect(siteData([repo], "kimlee").others).toEqual(["Kim", "Sam"]);
    const owned = (owner: string) => ({
      ...repo.items[0]!,
      id: owner,
      status: "open" as const,
      owner,
    });
    const more = { ...repo, items: [...repo.items, owned("An agent"), owned("The agent")] };
    expect(siteData([more]).others).toEqual(["Kim", "Sam"]);
    // The person is whoever the owner names, wherever: an agent drafting first leaves the item
    // the person's.
    const sends = siteData([{ ...repo, items: [...repo.items, owned("Ivo drafts, Kim sends")] }]);
    const row = sends.repos[0]!.items.find((i) => i.id === "Ivo drafts, Kim sends")!;
    expect([row.who, row.agent]).toEqual(["Kim", false]);
    // A name is whole: Kim never stands for Kim-Lee.
    const pair = siteData([{ ...repo, items: [owned("Kim"), owned("Kim-Lee")] }]);
    expect(pair.repos[0]!.items.map((i) => i.who)).toEqual(["Kim", "Kim-Lee"]);
    // The hub's user counts as a person where only a later word of an owner names them.
    expect(
      siteData([{ ...repo, items: [owned("Ivo drafts, Zoe sends")] }], "Zoe").repos[0]!.items[0]!
        .who,
    ).toBe("Zoe");
    // The filter offers every person who owns an open item, work alone included.
    expect(siteData([repo]).people.toSorted()).toEqual(["Alex", "Kim", "Sam"]);
  });
  test("leaving a page asks nothing: answers are stored as they are typed", () => {
    const script = readFileSync(join(import.meta.dir, "../site/src/admin.js"), "utf8");
    expect(script).not.toMatch(/beforeunload/);
  });
});

describe("admin.js", () => {
  // Built pages with the bundled script run in a DOM of their own, one browser's storage shared.
  let out = "";
  let code = "";
  const opened: Window[] = [];
  afterAll(() => Promise.all(opened.map((w) => w.happyDOM.close())));
  const open = (page: string, storage: Record<string, string>) => {
    const window = new Window({ url: `http://admin.localhost/${page}` });
    opened.push(window);
    for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
    window.document.write(
      readFileSync(join(out, `${page}.html`), "utf8").replace(/<script[^>]*><\/script>/g, ""),
    );
    window.eval(code);
    return window;
  };
  const stored = (w: Window) => ({ ...w.localStorage }) as Record<string, string>;

  beforeAll(async () => {
    out = join(scratch(), "out");
    await buildSite(siteData([await readRepo(repoFrom("spoke"))]), out);
    code = await script();
  }, 60_000);

  test("a copied answer leaves with its item, never while the item stays", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const answer = (h: number) => JSON.stringify({ done: true, note: "x", at: at(h) });
    const page = open("spoke/decisions", {
      "admin-answers:copied": at(12),
      // A work item lists on the work page, not here, and stays.
      "admin-answers:spoke:ask-the-printer": answer(10),
      "admin-answers:spoke:gone": answer(10),
      "admin-answers:spoke:gone-uncopied": answer(13),
      "admin-answers:other:gone": answer(10),
    });
    expect(Object.keys(stored(page)).sort()).toEqual([
      "admin-answers:before",
      "admin-answers:copied",
      "admin-answers:other:gone",
      "admin-answers:seen",
      "admin-answers:spoke:ask-the-printer",
      "admin-answers:spoke:gone-uncopied",
      "admin-answers:versions",
      "admin-answers:visit",
    ]);
  });

  test("an answer is stored as it is given, and the copy button counts it", () => {
    const page = open("spoke/decisions", {});
    const row = page.document.getElementById("spoke:pick-a-variant")!;
    const pick = row.querySelector('input[data-option][value="b"]') as DomInput;
    pick.checked = true;
    row.dispatchEvent(new page.Event("change"));
    expect(
      JSON.parse(page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
    ).toMatchObject({ option: "b", label: ["Variant B"] });
    expect(row.querySelector(".mark")!.textContent).toBe("✓ Variant B");
    expect(page.document.getElementById("copy")!.textContent).toBe("Copy 1 answer");
  });

  test("a closed row takes its recommendation, an assumption takes agree or veto, and a question put off copies nothing until the next visit", () => {
    const page = open("spoke/decisions", {});
    const row = (k: string) => page.document.getElementById(k) as unknown as DomElement;
    const variant = row("spoke:pick-a-variant");
    const take = variant.querySelector(".take") as DomElement;
    take.click();
    expect(variant.hasAttribute("open")).toBe(false);
    expect(variant.querySelector(".mark")!.textContent).toBe("✓ Variant A");
    expect(take.style.display).toBe("none");
    // An assumption has no recommendation to pick: Agree and Veto answer it.
    const cache = row("spoke:cache-folder");
    expect(cache.querySelector(".pick")).toBeNull();
    const veto = cache.querySelector("input[data-stance][value=veto]") as DomInput;
    veto.checked = true;
    cache.dispatchEvent(new page.Event("change"));
    (cache.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "keep a line";
    cache.querySelector("textarea")!.dispatchEvent(new page.Event("input"));
    expect(cache.querySelector(".mark")!.textContent).toBe("✓ veto");
    // The item's own task list keeps its ticks.
    expect(
      [...cache.querySelectorAll(".task-list-item-checkbox")].map((b) => (b as DomInput).checked),
    ).toEqual([true, false]);
    // Putting a question off clears its pick, and the copy leaves it out.
    const logo = row("spoke:pick-a-logo");
    (logo.querySelector(".pick") as DomElement).click();
    const later = logo.querySelector("input[value=later]") as DomInput;
    later.checked = true;
    later.dispatchEvent(new page.Event("change", { bubbles: true }));
    expect(logo.querySelectorAll("input[data-option]:checked").length).toBe(0);
    expect(logo.querySelector(".mark")!.textContent).toBe("later");
    const text = (page.document.getElementById("copy") as DomElement).dataset.hwCopy;
    expect(text).toContain("spoke:pick-a-variant: a (Variant A)");
    expect(text).toContain("spoke:cache-folder: veto, keep a line");
    expect(text).not.toContain("pick-a-logo");
    // The next visit asks it again; the answers stay.
    const back = open("spoke/decisions", {
      ...stored(page),
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
    });
    expect(back.localStorage.getItem("admin-answers:spoke:pick-a-logo")).toBeNull();
    // A note is an answer: it takes a question put off up again.
    later.checked = true;
    later.dispatchEvent(new page.Event("change", { bubbles: true }));
    (logo.querySelector("textarea") as unknown as HTMLTextAreaElement).value = "ask the printer";
    logo.querySelector("textarea")!.dispatchEvent(new page.Event("input"));
    expect(later.checked).toBe(false);
    expect((page.document.getElementById("copy") as DomElement).dataset.hwCopy).toContain(
      "spoke:pick-a-logo: ask the printer",
    );
    expect(back.localStorage.getItem("admin-answers:spoke:cache-folder")).not.toBeNull();
  });

  test("an answer given before its question or options changed is no current pick and copies as given", () => {
    const at = new Date(Date.UTC(2026, 0, 1, 9)).toISOString();
    const first = open("spoke/decisions", {});
    const asked = (k: string) =>
      (first.document.getElementById(k) as unknown as HTMLElement).dataset.asked!;
    const page = open("spoke/decisions", {
      // A label the item no longer carries for its key.
      "admin-answers:spoke:pick-a-variant": JSON.stringify({
        option: "a",
        label: ["The old label"],
        asked: "older",
        note: "go",
        at,
      }),
      // Stored before answers carried their question: compared by the label they copied.
      "admin-answers:spoke:name-the-command": JSON.stringify({
        option: "short",
        label: "A short name",
        at,
      }),
      "admin-answers:spoke:pick-a-logo": JSON.stringify({ option: "v02", label: "Variant 2", at }),
      // Several picks copy each label.
      "admin-answers:spoke:pick-recipients": JSON.stringify({
        option: "ben-sample,ada-example",
        asked: asked("spoke:pick-recipients"),
        label: ["Ben Sample", "Ada Example"],
        at,
      }),
    });
    const row = (k: string) => page.document.getElementById(k)!;
    const checked = (k: string) =>
      [...row(k).querySelectorAll("input[data-option]:checked")].map((i) => (i as DomInput).value);
    expect(checked("spoke:pick-a-variant")).toEqual([]);
    expect(checked("spoke:name-the-command")).toEqual([]);
    expect(checked("spoke:pick-a-logo")).toEqual(["v02"]);
    expect(checked("spoke:pick-recipients").sort()).toEqual(["ada-example", "ben-sample"]);
    expect(row("spoke:pick-a-variant").querySelector(".mark")!.textContent).not.toContain("✓");
    const notice = row("spoke:pick-a-variant").querySelector("[data-stale]")!;
    expect(notice.hasAttribute("hidden")).toBe(false);
    expect(notice.textContent).toContain("The old label");
    expect(row("spoke:pick-a-logo").querySelector("[data-stale]")!.hasAttribute("hidden")).toBe(
      true,
    );
    const block = (page.document.getElementById("copy") as DomElement).dataset.hwCopy!;
    expect(block).toContain("spoke:pick-a-variant: a (The old label), go; answered ");
    expect(block).toMatch(/spoke:name-the-command: short \(A short name\); answered .*changed/);
    expect(block).toContain(
      "spoke:pick-recipients: ben-sample (Ben Sample), ada-example (Ada Example)\n",
    );
    // Lines follow the page.
    const order = [...block.matchAll(/^spoke:([\w-]+):/gm)].map((m) => m[1]);
    const onPage = [...page.document.querySelectorAll("details.item[data-k]")]
      .map((d) => (d as unknown as HTMLElement).dataset.k!.slice("spoke:".length))
      .filter((k) => order.includes(k));
    expect(order).toEqual(onPage);
    // Picking again is the answer to the question as it stands now.
    const pick = row("spoke:pick-a-variant").querySelector('input[value="b"]') as DomInput;
    pick.checked = true;
    row("spoke:pick-a-variant").dispatchEvent(new page.Event("change"));
    expect(
      JSON.parse(page.localStorage.getItem("admin-answers:spoke:pick-a-variant")!),
    ).toMatchObject({ option: "b", label: ["Variant B"], asked: asked("spoke:pick-a-variant") });
    expect(row("spoke:pick-a-variant").querySelector("[data-stale]")!.hasAttribute("hidden")).toBe(
      true,
    );
  });

  test("a copy holds what was not copied yet, and everything again once nothing is new", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const page = open("spoke/decisions", {
      "admin-answers:copied": at(12),
      "admin-answers:spoke:pick-a-logo": JSON.stringify({
        option: "v02",
        label: "Variant 2",
        at: at(10),
      }),
      "admin-answers:spoke:check-the-copy": JSON.stringify({ note: "fine", at: at(13) }),
    });
    const copy = page.document.getElementById("copy") as DomElement;
    expect(copy.dataset.hwCopy).toContain("spoke:check-the-copy: fine");
    expect(copy.dataset.hwCopy).not.toContain("pick-a-logo");
    expect(copy.textContent).toBe("Copy 1 answer");
    expect(page.document.getElementById("state")!.textContent).toContain("1 not copied yet");
    const done = open("spoke/decisions", { ...stored(page), "admin-answers:copied": at(14) });
    const again = done.document.getElementById("copy") as DomElement;
    expect(again.dataset.hwCopy).toContain("pick-a-logo");
    expect(again.dataset.hwCopy).toContain("check-the-copy");
    expect(again.textContent).toBe("Copy 2 answers again");
    // The row says it went out.
    expect(
      done.document.getElementById("spoke:pick-a-logo")!.querySelector(".mark")!.textContent,
    ).toContain("copied");
  });

  test("the filters: kinds counted per person, own rows once, the first fold opens, a search finds what a row says", () => {
    const page = open("index", {});
    const doc = page.document;
    const button = (attr: string, v: string) =>
      doc.querySelector(`[${attr}="${v}"]`) as unknown as HTMLButtonElement;
    const count = (k: string) =>
      button("data-kind-button", k).querySelector("[data-kind-count]")!.textContent;
    const visible = () =>
      [...doc.querySelectorAll("[data-row]")].filter(
        (r) => !r.closest("[hidden]"),
      ) as unknown as HTMLElement[];
    const openRows = [
      ...doc.querySelectorAll("details.item[data-status=open]"),
    ] as unknown as HTMLElement[];
    const first = (doc.querySelector("[data-who-button]") as unknown as HTMLElement).dataset
      .whoButton!;
    const mine = openRows.filter((r) => !r.dataset.who || r.dataset.who === first);
    expect(Number(count("all"))).toBe(mine.length);
    expect(Number(count("decision"))).toBe(
      mine.filter((r) => r.dataset.kind === "decision").length,
    );
    // A kind filters the rows.
    button("data-kind-button", "decision").click();
    expect(visible().filter((r) => r.dataset.kind && r.dataset.kind !== "decision")).toEqual([]);
    button("data-kind-button", "all").click();
    // Kim's rows show under "Needs you", not a second time under "Waiting on others".
    button("data-who-button", "Kim").click();
    const kim = doc.querySelector('[data-who-group="Kim"]')!;
    expect(kim.closest("[hidden]")).not.toBeNull();
    expect(Number(count("all"))).toBeGreaterThan(0);
    // Kim has no Priority 2 or 3 row open by default: a fold with rows opens.
    const needs = doc.querySelector("[data-who-button]")!.closest("section")!;
    expect(
      [...needs.querySelectorAll("details[data-group]")].some(
        (g) => !g.closest("[hidden]") && (g as unknown as HTMLDetailsElement).open,
      ),
    ).toBe(true);
    button("data-who-button", "all").click();
    // The hidden "updated" mark is no text a search finds.
    const search = doc.getElementById("admin-search") as DomInput;
    search.value = "updated since";
    search.dispatchEvent(new page.Event("input"));
    expect(visible()).toEqual([]);
    expect(doc.getElementById("admin-nohit")!.hasAttribute("hidden")).toBe(false);
    expect(doc.getElementById("admin-nohit")!.textContent).toContain("“updated since”");
    // Every section without a row to show steps aside, but the one holding the filters.
    const filters = button("data-who-button", "all").closest("section");
    const left = [...doc.querySelectorAll("main section")].filter((x) => !x.hasAttribute("hidden"));
    expect(left.length === 1 && (left[0] as unknown) === filters).toBe(true);
    search.value = "";
    search.dispatchEvent(new page.Event("input"));
    expect(
      [...doc.querySelectorAll("main section")].filter((x) => x.hasAttribute("hidden")).length,
    ).toBe(0);
    // Another person's row the search finds shows under "Waiting on others".
    button("data-who-button", first).click();
    search.value = "printer";
    search.dispatchEvent(new page.Event("input"));
    expect(visible().length).toBeGreaterThan(0);
    expect(doc.getElementById("admin-nohit")!.hasAttribute("hidden")).toBe(true);
    // Where no other list shows it, a row of another person the search finds is named.
    const decisions = open("spoke/decisions", { "admin-answers:who": first });
    const find = decisions.document.getElementById("admin-search") as DomInput;
    find.value = "monthly";
    find.dispatchEvent(new decisions.Event("input"));
    expect(decisions.document.getElementById("admin-nohit")!.textContent).toContain(
      "1 row of other people does",
    );
    // A link followed on the page shows its row whatever person the filter is on.
    search.value = "";
    search.dispatchEvent(new page.Event("input"));
    const other = openRows.find((r) => r.dataset.who && r.dataset.who !== first)!;
    page.location.hash = `#${other.id}`;
    page.dispatchEvent(new page.Event("hashchange"));
    expect(!!other.closest("[hidden]")).toBe(false);
  });

  test("a new visit starts on the hub's user; a link to an item gone says so", () => {
    const hours = (h: number) => String(Date.now() - h * 36e5);
    const pressed = (w: Window) =>
      (w.document.querySelector('[data-who-button][aria-pressed="true"]') as unknown as HTMLElement)
        .dataset.whoButton;
    const later = open("index", { "admin-answers:who": "Kim", "admin-answers:seen": hours(0.5) });
    expect(pressed(later)).toBe("Kim");
    const back = open("index", { "admin-answers:who": "Kim", "admin-answers:seen": hours(30) });
    expect(pressed(back)).not.toBe("Kim");
    const window = new Window({ url: "http://admin.localhost/spoke/decisions#spoke:gone-item" });
    opened.push(window);
    window.document.write(
      readFileSync(join(out, "spoke/decisions.html"), "utf8").replace(
        /<script[^>]*><\/script>/g,
        "",
      ),
    );
    window.eval(code);
    const gone = window.document.getElementById("admin-gone")!;
    expect(gone.hasAttribute("hidden")).toBe(false);
    expect(gone.textContent).toContain("spoke:gone-item is no longer open");
  });

  test("an item changed since the visit before says so; a first visit marks nothing", () => {
    const shown = (w: Window) =>
      w.document.querySelectorAll("[data-row] [data-updated]:not([hidden])").length;
    expect(shown(open("index", {}))).toBe(0);
    const hours = (h: number) => String(Date.now() - h * 36e5);
    // Two hours away: every item of the fixture's one commit is newer than the last visit.
    const back = open("index", { "admin-answers:seen": hours(2) });
    expect(shown(back)).toBeGreaterThan(0);
    expect(Number(stored(back)["admin-answers:visit"])).toBeLessThan(Date.now() - 36e5);
    // A page view within the hour belongs to the same visit, and keeps its marks.
    expect(shown(open("spoke/work", stored(back)))).toBeGreaterThan(0);
    // Each fold that holds a marked row counts it, and the page says how many changed.
    const fold = back.document.querySelector(
      "details[data-group] [data-updated-count]:not([hidden])",
    )!;
    expect(fold.textContent).toMatch(/\d+ updated/);
    expect(back.document.getElementById("admin-since")!.textContent).toContain(
      "changed since your last visit",
    );
  });

  test("a row shown on the visit before compares its file, not its commit time", () => {
    const first = stored(open("index", {}));
    const versions = JSON.parse(first["admin-answers:versions"]!);
    const [changed] = Object.keys(versions);
    // Every item's commit is newer than the visit, but only one file differs from what it showed.
    const back = open("index", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:versions": JSON.stringify({ ...versions, [changed!]: "older" }),
    });
    const marked = [...back.document.querySelectorAll("[data-row]")].filter((r) =>
      r.querySelector("[data-updated]:not([hidden])"),
    );
    expect([...new Set(marked.map((r) => (r as unknown as HTMLElement).dataset.k))]).toEqual([
      changed,
    ]);
    // A stored question that differs says the question changed; the file alone, that it was edited.
    const [file] = versions[changed!].split(" ");
    const asked = open("index", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:versions": JSON.stringify({ ...versions, [changed!]: "older older" }),
    });
    const mark = (w: Window) =>
      w.document.querySelector(`[data-k="${changed}"] [data-updated]`)!.textContent;
    expect(mark(asked)).toContain("question or options changed");
    const edited = open("index", {
      "admin-answers:seen": String(Date.now() - 2 * 36e5),
      "admin-answers:versions": JSON.stringify({
        ...versions,
        [changed!]: `older ${versions[changed!].split(" ")[1]}`,
      }),
    });
    expect(mark(edited)).toContain("edited since");
    expect(file).toBeString();
  });
});

describe("serve", () => {
  test("a repository that never serves the hub installs no Tailwind or Astro for it", () => {
    // admin-serve stops and names a missing optional peer, so only a repository that serves pins it.
    for (const p of ["astro", "tailwindcss", "@tailwindcss/vite", "@tailwindcss/typography"])
      expect(peerDependenciesMeta).toHaveProperty([p, "optional"], true);
  });

  test("rebuilds on a new day, since a due date comes within a week with no commit", async () => {
    const hub = createHub({ root: dirname(repoFrom("spoke")) });
    const first = await hub.pages();
    expect(await hub.pages()).toBe(first);
    const now = Date.now;
    Date.now = () => now() + 864e5;
    try {
      expect(await hub.pages()).not.toBe(first);
    } finally {
      Date.now = now;
    }
  }, 120_000);

  test("a fetch that moves no ref rebuilds nothing, and the pages print its time", async () => {
    const repo = repoFrom("spoke");
    const hub = createHub({ root: dirname(repo) });
    const get = async (path: string) =>
      (await hub.fetch(new Request(`http://admin.localhost${path}`))).text();
    await hub.pages();
    const head = join(repo, ".git/FETCH_HEAD");
    writeFileSync(head, "");
    utimesSync(head, new Date(2026, 0, 2, 9, 5), new Date(2026, 0, 2, 9, 5));
    // A first fetch changes what the pages say: fetched or never.
    const fetched = await hub.pages();
    // The build runs in a child, whose time zone the test runner does not set.
    const at = (page: string) => page.match(/fetched ([^<]+)</)?.[1];
    const before = at(await get("/spoke/dashboard"));
    expect(before).toBeString();
    utimesSync(head, new Date(2026, 0, 3, 10, 7), new Date(2026, 0, 3, 10, 7));
    expect(await hub.pages()).toBe(fetched);
    const after = at(await get("/spoke/dashboard"));
    expect(after).not.toBe(before);
    // As a build from scratch prints it.
    const fresh = createHub({ root: dirname(repo) });
    const control = await (
      await fresh.fetch(new Request("http://admin.localhost/spoke/dashboard"))
    ).text();
    expect(after).toBe(at(control));
  }, 120_000);

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
    // Nothing a body commits loads from elsewhere, so no image or stylesheet reports a view or
    // reads the page out; a catalog's dev server is still asked whether it runs.
    for (const directive of [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' http://127.0.0.1:* http://localhost:*",
      "frame-ancestors 'self'",
    ])
      expect(csp("http://admin.localhost").split("; ")).toContain(directive);
    // A page elsewhere may link the hub, but loads nothing from it to learn what exists.
    const from = (site: string, mode: string, dest: string) =>
      hub.fetch(
        new Request("http://admin.localhost/_file/spoke/scripts/sample.ts", {
          headers: { "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": dest },
        }),
      );
    expect((await from("cross-site", "no-cors", "script")).status).toBe(403);
    // Another port of this machine is the same site, and asks no more than a site elsewhere.
    expect((await from("same-site", "cors", "empty")).status).toBe(403);
    expect((await from("cross-site", "navigate", "document")).status).toBe(200);
    expect((await from("same-site", "navigate", "document")).status).toBe(200);
    expect((await from("same-origin", "no-cors", "script")).status).toBe(200);
    expect((await from("none", "navigate", "document")).status).toBe(200);
    expect(decisions.headers.get("x-content-type-options")).toBe("nosniff");
    expect(decisions.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    for (const bare of ["/spoke", "/spoke/?who=A"]) {
      const r = await get(bare);
      expect([r.status, r.headers.get("location")]).toEqual([
        302,
        `http://admin.localhost/spoke/dashboard${bare.slice(6).replace(/^\//, "")}`,
      ]);
    }
    const none = await get("/nosuchrepo/");
    expect(none.status).toBe(404);
    // In the hub's styles, with the way back.
    const lost = await none.text();
    expect(lost).toContain('href="/">Open the hub</a>');
    expect(lost).toMatch(/<link rel="stylesheet" href="\/_astro\/[^"]+\.css">/);
    expect(lost).toContain('<code class="hw-inline-code">/nosuchrepo/</code>');
    // The hub says it is current as of the request.
    expect(first).toContain(`· as of ${when(Date.now())}`);
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

  test("a failed read or build shows on every page and is tried again once a state moves or a minute passed", async () => {
    const repo = repoFrom("spoke");
    const second = join(dirname(repo), "second");
    cpSync(repo, second, { recursive: true });
    // A missing object reads as a failed git call, never as a repository without items.
    const blob = sh(second, "git", "rev-parse", "HEAD:docs/agent-work/items/goal.md").trim();
    const object = join(second, ".git/objects", blob.slice(0, 2), blob.slice(2));
    const bytes = readFileSync(object);
    rmSync(object);
    const now = Date.now;
    const later = (ms: number) => (Date.now = () => now() + ms);
    const hub = createHub({ root: dirname(repo) });
    const get = async (path: string) =>
      (await hub.fetch(new Request(`http://admin.localhost${path}`))).text();
    const notice = (html: string) => html.match(/<div id="admin-problem"[^>]*>[\s\S]*?<\/div>/)![0];
    const first = await hub.pages();
    expect(notice(await get("/"))).toContain("second could not be read: git cat-file answered");
    expect(notice(await get("/spoke/doc/docs/agent-work/2026-01-15-sample-topic"))).toContain(
      "It is left out.",
    );
    expect(await hub.pages()).toBe(first);
    const spawn = Bun.spawn;
    let builds = 0;
    const failing = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: object) => {
      if (!cmd[1]?.endsWith("serve.ts")) return spawn(cmd, opts as never);
      builds++;
      return spawn([process.execPath, "-e", "console.error('TypeError: boom'); process.exit(1)"], {
        stderr: "pipe",
      });
    }) as typeof Bun.spawn);
    try {
      writeFileSync(join(repo, "moved.md"), "# Moved\n");
      sh(repo, "git", "add", "moved.md");
      commit(repo, "m");
      // The last pages stay on show, saying since when.
      expect(await hub.pages()).toBe(first);
      expect(await hub.pages()).toBe(first);
      expect(builds).toBe(1);
      expect(notice(await get("/spoke/dashboard"))).toMatch(
        /could not rebuild on [^<]+<\/b> These pages show the repositories as of [\s\S]*The build stopped: build failed: TypeError: boom/,
      );
      later(61_000);
      expect(await hub.pages()).toBe(first);
      expect(builds).toBe(2);
    } finally {
      Date.now = now;
      failing.mockRestore();
    }
    writeFileSync(join(repo, "moved.md"), "# Moved again\n");
    sh(repo, "git", "add", "moved.md");
    commit(repo, "n");
    expect(await hub.pages()).not.toBe(first);
    expect(notice(await get("/"))).not.toContain("The build stopped");
    expect(await get("/")).toContain("second could not be read");
    // A read that failed for a passing cause comes back a minute later, with no commit there.
    writeFileSync(object, bytes);
    try {
      // Past the retry the mocked minute above set.
      later(125_000);
      expect(await get("/")).not.toContain("could not be read");
    } finally {
      Date.now = now;
    }
  }, 120_000);

  test("two checkouts with one key, or a key the hub's pages take, each keep their own pages", async () => {
    const repo = repoFrom("spoke", "catalog");
    const root = dirname(repo);
    for (const at of ["a", "b"]) cpSync(repo, join(root, at, "web"), { recursive: true });
    writeFileSync(join(root, "b/web/README.md"), "# Only in b\n");
    sh(join(root, "b/web"), "git", "add", "README.md");
    commit(join(root, "b/web"), "b");
    const hub = createHub({ root });
    const get = async (path: string) =>
      (await hub.fetch(new Request(`http://admin.localhost${path}`))).text();
    const home = await get("/");
    for (const key of ["a-web", "b-web", `${basename(root)}-catalog`])
      expect(home).toContain(`>${key}<`);
    expect(home).toContain("key web names another checkout too: its pages are under b-web");
    expect(await get("/b-web/doc/README")).toContain("Only in b");
    expect(await get("/a-web/doc/README")).toContain("<h1>No such page</h1>");
  }, 120_000);

  test("serves each doc page from its depth's shell, as a full build renders it", async () => {
    // A path with characters a page escapes in its attributes.
    const plain = repoFrom("spoke");
    const repo = join(dirname(plain), "o'neil & co", "spoke");
    cpSync(plain, repo, { recursive: true });
    rmSync(plain, { recursive: true, force: true });
    mkdirSync(join(repo, "docs/guide"), { recursive: true });
    const files: Record<string, string> = {
      "README.md":
        "# Read me\n\nSee [setup](docs/guide/index.md#setup) and [notes](docs/c%23-notes.md).\n",
      "docs/guide/index.md": "# Guide\n\n## Setup\n",
      "docs/c#-notes.md": "# C# notes & more\n",
      "docs/50% off.md": "# Half off\n",
      "docs/rock & roll's.md": "# Rock and roll\n",
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
    sh(repo, "git", "add", "-A");
    commit(repo, "docs");
    const hub = createHub({ root: dirname(repo) });
    const at = "http://admin.localhost/spoke/docs";
    const get = (path: string) => hub.fetch(new Request(new URL(path, at)));
    const list = await (await get(at)).text();
    const data = await readRepo(repo);
    for (const doc of [...data.reports, ...data.docs]) {
      const link = list.match(
        new RegExp(`href="([^"]+)">\\s*${RegExp.escape(Bun.escapeHTML(doc.title))}`),
      );
      const page = await get(link![1]!);
      expect([doc.path, page.status]).toEqual([doc.path, 200]);
      expect(await page.text()).toContain(`<h1>${Bun.escapeHTML(doc.title)}</h1>`);
    }
    const readme = await (await get("/spoke/doc/README")).text();
    // A link to another doc opens its page, the fragment kept.
    expect(readme).toContain('href="/spoke/doc/docs/guide/index.md#setup"');
    expect(readme).toContain('href="/spoke/doc/docs/c%23-notes"');
    expect((await get("/spoke/doc/docs/c%23-notes")).status).toBe(200);
    const notes = await (await get("/spoke/doc/docs/c%23-notes")).text();
    expect(notes).toContain("<title>C# notes &amp; more · spoke · Admin</title>");
    expect(notes).toContain('href="/_file/spoke/docs/c%23-notes.md"');
    expect(await (await get("/_file/spoke/docs/c%23-notes.md")).text()).toBe(
      files["docs/c#-notes.md"],
    );
    expect(await (await get("/spoke/doc/docs/rock%20&%20roll's")).text()).toContain(
      'href="/_file/spoke/docs/rock%20%26%20roll%27s.md"',
    );
    // A doc's address with a slash leads to it.
    const slash = await get("/spoke/doc/README/?x=1");
    expect([slash.status, slash.headers.get("location")]).toEqual([
      302,
      "http://admin.localhost/spoke/doc/README?x=1",
    ]);
    // A doc filled into its shell is the page a full build renders, served with the same links:
    // the article's links to docs open their pages, the line above it opens the file.
    const out = join(scratch(), "out");
    await buildSite(siteData([data]), out);
    const served = linker([data]);
    for (const page of [
      "README",
      "docs/guide/index.md",
      "docs/agent-work/2026-01-15-sample-topic",
      "docs/rock & roll's",
    ]) {
      const built = readFileSync(join(out, `spoke/doc/${page}.html`), "utf8");
      expect(await (await get(`/spoke/doc/${page}`)).text()).toBe(
        served.files(built.replace(/<article[\s\S]*<\/article>/, (a) => served.pages(a))),
      );
    }
    // A doc's slug may itself end in .html, which only the hub's shells serve: Astro builds none.
    writeFileSync(join(repo, "docs/page.html.md"), "# Named like a page\n");
    sh(repo, "git", "add", "docs/page.html.md");
    commit(repo, "page");
    expect((await get("/spoke/doc/docs/page.html")).status).toBe(200);
  }, 120_000);

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
