import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { version } from "../package.json";
import { compareItems, imagesOf, ITEMS_DIR, type Item } from "./items.ts";
import { diagram } from "./diagrams.ts";
import { renderItemMarkdown } from "./markdown.ts";
import type { Doc, RepoData } from "./repo.ts";
import { docSlug, fileHref } from "./repo-paths.ts";

export const PKG = join(import.meta.dirname, "..");

export type ViewItem = Item & {
  // The item file's last commit, in seconds.
  changed?: number;
  version?: string;
  repo: string;
  repoLabel: string;
  who: string;
  // Owned by an agent rather than a person: no person filter hides it.
  agent: boolean;
  html: string;
  // Option key to its images, "" for the item's own, each with its file URL.
  optionImages: Record<string, { src: string; caption?: string }[]>;
  recommendedKeys: string[];
  recommendedLabel?: string;
  waitingOn: string[];
  waitingCount: number;
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
  topic?: true;
  topicGraph?: string;
  // A doc page's own doc, where no list of the repository holds it: the shell's marks.
  article?: Doc;
  product?: number;
  title: string;
};

export type SiteData = {
  version: string;
  people: string[];
  // People other than the hub's user, and companies and teams, who own an open item: its
  // "Waiting on others".
  others: string[];
  repos: (Omit<RepoData, "items" | "workFiles" | "label"> & {
    label: string;
    items: ViewItem[];
    needsSvg?: string;
    prefix: string;
    dashboard: string;
  })[];
  pages: Page[];
  // Set by buildSite, never by the catalog: the nonce its pages' own scripts carry.
  nonce?: string;
};

// A file path under docs/agent-work links into the repository named right before it ("website
// `docs/...`") or after it ("`...` in trainer-hub"), else into the item's own, and stays text where
// that repository holds no such file. A Markdown link relative to the item file is rewritten like a
// report's. An existing link keeps its text, so no link nests in another.
function itemHtml(
  repo: RepoData,
  byKey: Map<string, RepoData>,
  files: Map<RepoData, Set<string>>,
  item: Item,
) {
  const html = renderItemMarkdown(repo.path, `${ITEMS_DIR}/${item.id}.md`, item.body);
  const named = (before: string, after: string) =>
    [
      before.match(/([\w.-]+)\s+(?:<code[^>]*>)?$/)?.[1],
      after.match(/^(?:<\/code>)?\s+in\s+([\w.-]+)/)?.[1],
    ].find((k) => k && byKey.has(k));
  // A link or a tag goes through whole, so no path inside an attribute becomes a link.
  return html.replace(
    /(<svg\b[\s\S]*?<\/svg>|<a\b[\s\S]*?<\/a>|<[^>]*>)|(?<![\w/"=])(docs\/agent-work\/[\w./äöüÄÖÜß-]*\w)/g,
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

function prerequisiteSummary(items: Item[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const waitingOn = new Map<string, string[]>();
  const waitingCount = new Map<string, number>();
  for (const item of items) {
    if (!item.needs?.length) continue;
    const seen = new Set([item.id]);
    const pending = [...item.needs];
    const open: string[] = [];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const target = byId.get(id);
      if (!target) continue;
      if (target.needs) pending.push(...target.needs);
      if (target.status === "open") {
        open.push(id);
        if (item.status === "open") waitingCount.set(id, (waitingCount.get(id) ?? 0) + 1);
      }
    }
    waitingOn.set(item.id, open.sort());
  }
  return { waitingOn, waitingCount };
}

export function needsGraphItems(items: ViewItem[]) {
  const ids = new Set(items.map((i) => i.id));
  const connected = new Set<string>();
  for (const item of items)
    for (const id of item.needs ?? [])
      if (id !== item.id && ids.has(id)) {
        connected.add(item.id);
        connected.add(id);
      }
  return items.filter((i) => connected.has(i.id));
}

export function needsGraph(items: ViewItem[]) {
  const nodes = new Map(items.map((item, index) => [item.id, { id: `n${index}`, item }]));
  const source = ["flowchart LR"];
  for (const { id, item } of nodes.values()) {
    const title = item.title.replace(
      /["&<\])\\*~\r\n\u2028\u2029]/g,
      (c) => `&amp;#${c.charCodeAt(0)};`,
    );
    const label = `"${title}"`;
    const shape =
      item.status !== "open" ? `(${label})` : item.waitingOn.length ? `[${label}]` : `([${label}])`;
    source.push(id + shape);
  }
  for (const { id, item } of nodes.values())
    for (const need of new Set(item.needs)) {
      const prerequisite = nodes.get(need);
      if (need === item.id || !prerequisite) continue;
      const arrow = prerequisite.item.status === "open" ? "-->" : "-.->";
      source.push(`${prerequisite.id} ${arrow} ${id}`);
    }
  const rendered = diagram(source.join("\n"), "admin-needs-");
  if (rendered.startsWith("<figure")) return rendered.replace(/&amp;#(\d+);/g, "&#$1;");
}

// `you` is the hub's user where an item owner names them, else the first person.
export function siteData(repos: RepoData[], you?: string): SiteData {
  // An owner's first word is an agent's where it is lower-case ("an agent", "claude-code"), an
  // article, "Agent", an agent runtime's own name (Claude, Codex) or a name an agent definition
  // gives. A person is the hub's user or an upper-case first word of some open item's owner that is
  // no agent's, and an item is the first person its owner names anywhere, so "Ivo drafts, Kim
  // sends" is Kim's. A first word joined to the next by "+" or "&" is part of a company's name. An
  // owner naming no person and starting no agent's way is a company's or a team's ("B+L", "eBike
  // Works"), named by the owner up to its first comma, semicolon or "(".
  const agents = new Set(repos.flatMap((r) => r.agents));
  const isAgent = (w: string) =>
    /^\p{Ll}[\p{Ll}\p{N}-]*$/u.test(w) ||
    /^(a|an|the|agent|claude|codex)$/i.test(w) ||
    agents.has(w);
  const open = repos.flatMap((r) => r.items.filter((i) => i.status === "open"));
  const joined = (owner: string) => /^[+&]/.test(owner.slice(firstWord(owner).length));
  const names = [
    ...new Set([you ?? "", ...open.map((i) => (joined(i.owner ?? "") ? "" : firstWord(i.owner)))]),
  ]
    .filter((p) => /^\p{Lu}/u.test(p) && !isAgent(p))
    .map((p) => ({ p, re: new RegExp(`(?<![\\p{L}\\p{N}-])${p}(?![\\p{L}\\p{N}-])`, "u") }));
  const ownerOf = (owner = "") => {
    const person = names
      .map(({ p, re }) => ({ p, at: owner.search(re) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0]?.p;
    if (person) return { who: person, as: "person" };
    const party = owner.split(/[,;(]/)[0]!.trim();
    return !party || (!joined(owner) && isAgent(firstWord(owner)))
      ? { who: firstWord(owner), as: "agent" }
      : { who: party, as: "party" };
  };
  // The filter offers every person who owns an open item: the hub's user first, then whoever owns
  // the most open questions, then the most items; it starts on the first.
  const asked = new Map<string, number>();
  const owned = new Map<string, number>();
  const parties = new Set<string>();
  for (const i of open) {
    const { who: p, as } = ownerOf(i.owner);
    if (as === "party") parties.add(p);
    if (as !== "person") continue;
    owned.set(p, (owned.get(p) ?? 0) + 1);
    if (i.kind === "decision" || i.kind === "review") asked.set(p, (asked.get(p) ?? 0) + 1);
  }
  const n = (m: Map<string, number>, p: string) => m.get(p) ?? 0;
  const people = [...owned.keys()].sort(
    (a, b) =>
      +(b === you) - +(a === you) ||
      n(asked, b) - n(asked, a) ||
      n(owned, b) - n(owned, a) ||
      a.localeCompare(b),
  );
  // Who else moves next: the other people, and the companies and teams, which have no button.
  const others = [...people.slice(1), ...parties].sort();
  const pages: Page[] = [
    { path: "index", type: "hub", title: "Admin hub" },
    { path: "architecture", type: "hub-architecture", title: "Packages" },
    // What admin-serve answers where no page is.
    { path: "404", type: "missing", title: "No such page" },
  ];
  // A repository without admin.label goes by its key; the hub lists them by that name.
  const named = repos
    .map((r) => ({ ...r, label: r.label ?? r.key }))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));
  const byKey = new Map(named.map((r) => [r.key, r]));
  const files = new Map(named.map((r) => [r, new Set(r.workFiles)]));
  const out = named.map((r) => {
    const prefix = `${r.key}/`;
    const { waitingOn, waitingCount } = prerequisiteSummary(r.items);
    const items = [...r.items].sort(compareItems).map((i) => {
      const recommendedKeys = [i.recommended ?? []].flat();
      const { who, as } = ownerOf(i.owner);
      return {
        ...i,
        waitingOn: waitingOn.get(i.id) ?? [],
        waitingCount: waitingCount.get(i.id) ?? 0,
        repo: r.key,
        repoLabel: r.label,
        who,
        html: itemHtml(r, byKey, files, i),
        agent: !!i.owner && as === "agent",
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
    pages.push({ path: dashboard, type: "dashboard", repo: r.key, title: `${r.label} admin` });
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
    const topics = Map.groupBy(items, (i) => i.topic);
    for (const d of [...r.reports, ...r.docs]) {
      const topic = "stem" in d && typeof d.stem === "string" ? (topics.get(d.stem) ?? []) : [];
      const topicGraph = topic.some((i) => i.kind === "work" || i.kind === "goal")
        ? needsGraph(topic)
        : undefined;
      add({
        path: docSlug(d.path),
        type: "doc",
        doc: d.path,
        title: d.title,
        topic: topic.length ? true : undefined,
        topicGraph,
      });
    }
    const { workFiles: _, ...rest } = r;
    const connected = needsGraphItems(items);
    const needsSvg = connected.length ? needsGraph(connected) : undefined;
    return { ...rest, items, prefix, dashboard, ...(needsSvg && { needsSvg }) };
  });
  return { version, people, others, repos: out, pages };
}

// Only topic reports are built as individual doc pages. The hub fills every other doc on
// request from its repository's shell, built once per folder depth so its relative links work.
export const SHELL = {
  name: "admin-shell-name",
  path: "admin-shell-path",
  title: "admin-shell-title",
  titleId: "admin-shell-anchor",
  html: "admin-shell-html",
};
export const shellPath = (prefix: string, depth: number) =>
  `${prefix}_shell/${"_/".repeat(depth - 3)}${SHELL.name}`;

export function shelled(data: SiteData): SiteData {
  const docs = data.pages.filter((p) => p.type === "doc" && !p.topic);
  const pages = data.pages.filter((p) => p.type !== "doc" || p.topic);
  const topicDocs = new Set(pages.filter((p) => p.topic).map((p) => p.path));
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
      reports: r.reports.map((d) =>
        topicDocs.has(r.prefix + docSlug(d.path)) ? d : { ...d, html: "" },
      ),
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

export function writeSiteData(file: string, data: SiteData) {
  // From disk 'self' admits every file:// script, a doc's committed one included, and a
  // hash needs CORS there, so a per-build nonce marks the pages' own.
  writeFileSync(file, JSON.stringify({ ...data, nonce: crypto.randomUUID() }));
}

// Builds the pages into `outDir`. Astro writes absolute /_astro/ URLs; each page gets them
// relative, so the folder opens from disk and can move.
export async function buildSite(data: SiteData | { file: string }, outDir: string) {
  // Astro bundles a prerender entry beside its output when that sits inside the working
  // directory, and resolves its packages from there, so the build runs in a folder inside this
  // package, where node resolution reaches the package's dependencies, nested or hoisted. Its
  // .astro folder lands there too, never in the spoke.
  const work = mkdtempSync(join(PKG, "site", ".build-"));
  const built = join(work, "out");
  const cwd = process.cwd();
  process.chdir(work);
  try {
    const file = "file" in data ? data.file : join(work, "data.json");
    if (!("file" in data)) writeSiteData(file, data);
    writeFileSync(join(work, "admin.css"), stylesheet());
    writeFileSync(join(work, "admin.js"), await script());
    process.env.ADMIN_DATA = file;
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
