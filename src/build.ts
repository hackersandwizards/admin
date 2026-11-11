import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { compareItems, imagesOf, ITEMS_DIR, type Item } from "./items.ts";
import { docSlug, fileHref, renderMarkdown, type Doc, type RepoData } from "./repo.ts";

export const PKG = join(import.meta.dirname, "..");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version as string;

export type ViewItem = Item & {
  // The item file's last commit, in seconds.
  changed?: number;
  version?: string;
  repo: string;
  who: string;
  // Owned by an agent rather than a person: no person filter hides it.
  agent: boolean;
  html: string;
  // Option key to its images, "" for the item's own, each with its file URL.
  optionImages: Record<string, { src: string; caption?: string }[]>;
  recommendedKeys: string[];
  recommendedLabel?: string;
};

export const PAGE_TYPES = [
  "hub",
  "hub-architecture",
  "dashboard",
  "decisions",
  "work",
  "reviews",
  "docs",
  "doc",
  "catalog",
  "product",
  "architecture",
  "checks",
  "log",
  "missing",
] as const;

export type Page = {
  path: string;
  type: (typeof PAGE_TYPES)[number];
  repo?: string;
  doc?: string;
  // A doc page's own doc, where no list of the repository holds it: the shell's marks.
  article?: Doc;
  product?: number;
  title: string;
};

export type SiteData = {
  version: string;
  people: string[];
  // People other than the hub's user who own an open item: its "Waiting on others".
  others: string[];
  repos: (Omit<RepoData, "items" | "workFiles"> & {
    items: ViewItem[];
    prefix: string;
    dashboard: string;
  })[];
  pages: Page[];
};

// A file path under docs/agent-work links into the repository named right before it ("website
// `docs/...`") or after it ("`...` in trainer-hub"), else into the item's own, and stays text where
// that repository holds no such file. A Markdown link relative to the item file is rewritten like a
// report's. An existing link keeps its text, so no link nests in another.
function itemHtml(
  repo: RepoData,
  byKey: Map<string, RepoData>,
  files: Map<RepoData, Set<string>>,
  text: string,
) {
  const html = renderMarkdown(repo.path, `${ITEMS_DIR}/item.md`, text, true);
  const named = (before: string, after: string) =>
    [
      before.match(/([\w.-]+)\s+(?:<code[^>]*>)?$/)?.[1],
      after.match(/^(?:<\/code>)?\s+in\s+([\w.-]+)/)?.[1],
    ].find((k) => k && byKey.has(k));
  // A link or a tag goes through whole, so no path inside an attribute becomes a link.
  return html.replace(
    /(<a\b[\s\S]*?<\/a>|<[^>]*>)|(?<![\w/"=])(docs\/agent-work\/[\w./äöüÄÖÜß-]*\w)/g,
    (whole, tag: string | undefined, p: string, at: number) => {
      if (tag) return tag;
      const key = named(html.slice(Math.max(0, at - 80), at), html.slice(at + p.length));
      const target = key ? byKey.get(key)! : repo;
      return files.get(target)!.has(p)
        ? `<a class="hw-link" href="${Bun.escapeHTML(fileHref(join(target.path, p)))}">${p}</a>`
        : p;
    },
  );
}

export const firstWord = (owner = "") => owner.match(/^[\p{L}\p{N}-]+/u)?.[0] ?? owner;

// `you` is the hub's user where an item owner names them, else the first person.
export function siteData(repos: RepoData[], you?: string): SiteData {
  // A person is the hub's user or a name that opens some open item's owner, unless lower-case
  // ("an agent"), an article, "Agent", an agent runtime's own name (Claude, Codex) or a name an
  // agent definition gives. An item is the first
  // person its owner names anywhere, so "Ivo drafts, Kim sends" is Kim's; with none it is its first
  // word's.
  const agents = new Set(repos.flatMap((r) => r.agents));
  const isPerson = (p: string) =>
    /^\p{Lu}/u.test(p) && !/^(a|an|the|agent|claude|codex)$/i.test(p) && !agents.has(p);
  const open = repos.flatMap((r) => r.items.filter((i) => i.status === "open"));
  const names = [...new Set([you ?? "", ...open.map((i) => firstWord(i.owner))])]
    .filter(isPerson)
    .map((p) => ({ p, re: new RegExp(`(?<![\\p{L}\\p{N}-])${p}(?![\\p{L}\\p{N}-])`, "u") }));
  const named = (owner = "") =>
    names
      .map(({ p, re }) => ({ p, at: owner.search(re) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0]?.p ?? firstWord(owner);
  // The filter offers every person who owns an open item: the hub's user first, then whoever owns
  // the most open questions, then the most items; it starts on the first.
  const asked = new Map<string, number>();
  const owned = new Map<string, number>();
  for (const i of open) {
    const p = named(i.owner);
    owned.set(p, (owned.get(p) ?? 0) + 1);
    if (i.kind === "decision" || i.kind === "review") asked.set(p, (asked.get(p) ?? 0) + 1);
  }
  const n = (m: Map<string, number>, p: string) => m.get(p) ?? 0;
  const people = [...owned.keys()]
    .filter(isPerson)
    .sort(
      (a, b) =>
        +(b === you) - +(a === you) ||
        n(asked, b) - n(asked, a) ||
        n(owned, b) - n(owned, a) ||
        a.localeCompare(b),
    );
  const others = people.slice(1).sort();
  const pages: Page[] = [
    { path: "index", type: "hub", title: "Admin hub" },
    { path: "architecture", type: "hub-architecture", title: "Packages" },
    // What admin-serve answers where no page is.
    { path: "404", type: "missing", title: "No such page" },
  ];
  const byKey = new Map(repos.map((r) => [r.key, r]));
  const files = new Map(repos.map((r) => [r, new Set(r.workFiles)]));
  const out = repos.map((r) => {
    const prefix = `${r.key}/`;
    const items = [...r.items].sort(compareItems).map((i) => {
      const recommendedKeys = [i.recommended ?? []].flat();
      const who = named(i.owner);
      return {
        ...i,
        repo: r.key,
        who,
        html: itemHtml(r, byKey, files, i.body),
        agent: !!i.owner && !isPerson(who),
        optionImages: Object.fromEntries(
          Object.entries(imagesOf(i)).map(([k, list]) => [
            k,
            list.map((m) => ({ ...m, src: fileHref(join(r.path, m.src)) })),
          ]),
        ),
        recommendedKeys,
        recommendedLabel:
          recommendedKeys.length > 3
            ? `${recommendedKeys.length} options`
            : i.options
                ?.filter((o) => recommendedKeys.includes(o.key))
                .map((o) => o.label)
                .join(", "),
      };
    });
    const add = (p: Omit<Page, "repo" | "path"> & { path: string }) =>
      pages.push({ ...p, path: prefix + p.path, repo: r.key });
    // A slug ending in "index" collides with the folder's own route, so a repo's dashboard is
    // <repo>/dashboard.
    const dashboard = `${prefix}dashboard`;
    pages.push({ path: dashboard, type: "dashboard", repo: r.key, title: `${r.key} admin` });
    add({ path: "decisions", type: "decisions", title: "Decisions" });
    add({ path: "work", type: "work", title: "Work" });
    add({ path: "reviews", type: "reviews", title: "Reviews" });
    add({ path: "docs", type: "docs", title: "Docs" });
    if (r.designSystem) add({ path: "catalog", type: "catalog", title: "Catalog" });
    r.products.forEach((p, n) =>
      add({ path: `products-${n + 1}`, type: "product", product: n, title: p.label }),
    );
    add({ path: "architecture", type: "architecture", title: "Architecture" });
    add({ path: "checks", type: "checks", title: "Checks" });
    add({ path: "log", type: "log", title: "Log" });
    for (const d of [...r.reports, ...r.docs])
      add({
        path: docSlug(d.path),
        type: "doc",
        doc: d.path,
        title: d.title,
      });
    const { workFiles: _, ...rest } = r;
    return { ...rest, items, prefix, dashboard };
  });
  return { version: VERSION, people, others, repos: out, pages };
}

// The hub builds no doc page: it fills a doc into its repository's shell on request, a doc page
// built once per folder depth with these marks in place of the doc, so that a build covers the list
// pages alone. The depth decides every relative link of a page, so a shell's links hold for each
// doc at its depth.
export const SHELL = {
  name: "admin-shell-name",
  path: "admin-shell-path",
  title: "admin-shell-title",
  html: "admin-shell-html",
};
export const shellPath = (prefix: string, depth: number) =>
  `${prefix}_shell/${"_/".repeat(depth - 3)}${SHELL.name}`;

export function shelled(data: SiteData): SiteData {
  const docs = data.pages.filter((p) => p.type === "doc");
  const pages = data.pages.filter((p) => p.type !== "doc");
  const repos = data.repos.map((r) => {
    for (const depth of new Set(
      docs.filter((p) => p.repo === r.key).map((p) => p.path.split("/").length),
    ))
      pages.push({
        path: shellPath(r.prefix, depth),
        type: "doc",
        repo: r.key,
        title: SHELL.title,
        article: SHELL,
      });
    return {
      ...r,
      reports: r.reports.map((d) => ({ ...d, html: "" })),
      docs: r.docs.map((d) => ({ ...d, html: "" })),
    };
  });
  return { ...data, repos, pages };
}

// Every path is resolved, since the package may sit hoisted or nested.
export function stylesheet() {
  const at = (spec: string) => Bun.resolveSync(spec, PKG);
  const brandRoot = dirname(at("@hackersandwizards/brand/package.json"));
  return [
    `@import "${at("tailwindcss/index.css")}";`,
    `@plugin "${at("@tailwindcss/typography")}";`,
    `@import "${at("@hackersandwizards/brand/tokens.css")}";`,
    `@import "${at("@hackersandwizards/brand/expert.css")}";`,
    `@import "${at("@hackersandwizards/brand/header.css")}";`,
    `@import "${at("@hackersandwizards/brand/elements.css")}";`,
    `@import "${at("@hackersandwizards/brand/marker.css")}";`,
    `@import "${at("@hackersandwizards/brand/fonts.css")}";`,
    `@import "${join(PKG, "site/src/layout.css")}";`,
    `@source "${join(PKG, "site/src")}";`,
    `@source "${join(brandRoot, "expert")}";`,
    `@source "${join(brandRoot, "elements")}";`,
    `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`,
  ].join("\n");
}

// admin.js with brand's element script, as one classic script.
export async function script() {
  const { outputs } = await Bun.build({
    entrypoints: [join(PKG, "site/src/admin.js")],
    format: "iife",
    minify: true,
  });
  return outputs[0]!.text();
}

// Builds the pages into `outDir`. Astro writes absolute /_astro/ URLs; each page gets them
// relative, so the folder opens from disk and can move.
export async function buildSite(data: SiteData, outDir: string) {
  // Astro bundles a prerender entry beside its output when that sits inside the working
  // directory, and resolves its packages from there, so the build runs in a folder inside this
  // package, where node resolution reaches the package's dependencies, nested or hoisted. Its
  // .astro folder lands there too, never in the spoke.
  const work = mkdtempSync(join(PKG, "site", ".build-"));
  const built = join(work, "out");
  const cwd = process.cwd();
  process.chdir(work);
  try {
    writeFileSync(join(work, "data.json"), JSON.stringify(data));
    writeFileSync(join(work, "admin.css"), stylesheet());
    writeFileSync(join(work, "admin.js"), await script());
    process.env.ADMIN_DATA = join(work, "data.json");
    const { build } = await import("astro");
    const tailwind = (await import("@tailwindcss/vite")).default;
    await build({
      root: join(PKG, "site"),
      configFile: false,
      outDir: built,
      cacheDir: join(work, "cache"),
      logLevel: "error",
      build: { format: "file", inlineStylesheets: "never" },
      vite: {
        cacheDir: join(work, "vite"),
        plugins: [tailwind()],
        resolve: {
          alias: {
            "admin:styles": join(work, "admin.css"),
            "admin:script?url": `${join(work, "admin.js")}?url`,
          },
        },
        build: { assetsInlineLimit: 0 },
      },
    });
    rmSync(join(built, ".prerender"), { recursive: true, force: true });
    relativize(built);
    cpSync(built, outDir, { recursive: true });
  } finally {
    process.chdir(cwd);
    rmSync(work, { recursive: true, force: true });
  }
}

// The engine's own catalog, as `bun run build` builds it, into `outDir`, run from the package with
// caches beside the output, so a build the gate runs meanwhile keeps its own.
export async function buildCatalog(outDir: string) {
  const { build } = await import("astro");
  process.chdir(PKG);
  await build({
    root: join(PKG, "catalog"),
    outDir,
    cacheDir: join(outDir, "..", "cache"),
    logLevel: "error",
    vite: { cacheDir: join(outDir, "..", "vite") },
  });
}

export const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

function relativize(outDir: string) {
  for (const file of filesUnder(outDir)) {
    if (file.endsWith(".html")) {
      const up = relative(dirname(file), outDir) || ".";
      const html = readFileSync(file, "utf8").replaceAll('"/_astro/', `"${up}/_astro/`);
      writeFileSync(file, html);
    } else if (file.endsWith(".css")) {
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("/_astro/", "./"));
    }
  }
}
