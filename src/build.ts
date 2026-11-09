import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { compareItems, imagesOf, type Item } from "./items.ts";
import { fileHref, withElements, type RepoData } from "./repo.ts";

export const PKG = join(import.meta.dirname, "..");
export const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"))
  .version as string;

export type ViewItem = Item & {
  repo: string;
  who: string;
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
] as const;

export type Page = {
  path: string;
  type: (typeof PAGE_TYPES)[number];
  repo?: string;
  doc?: string;
  product?: number;
  title: string;
};

export type SiteData = {
  version: string;
  people: string[];
  // People other than the hub's user who own an open item: its "Waiting on others".
  others: string[];
  repos: (Omit<RepoData, "items"> & { items: ViewItem[]; prefix: string; dashboard: string })[];
  pages: Page[];
};

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function itemHtml(repo: RepoData, text: string) {
  const paths = new Set(repo.reports.map((r) => r.path).concat(repo.docs.map((d) => d.path)));
  return withElements(Bun.markdown.html(text)).replace(
    /(?<![\w/"=])(docs\/agent-work\/[\w./äöüÄÖÜß-]*\w)/g,
    (p) =>
      paths.has(p) || p.endsWith("/") || /\.\w+$/.test(p)
        ? `<a class="hw-link" href="${escape(fileHref(join(repo.path, p)))}">${p}</a>`
        : p,
  );
}

export const firstWord = (owner = "") => owner.match(/^[\p{L}\p{N}-]+/u)?.[0] ?? owner;

// `you` is the hub's user, the first person when none is named.
export function siteData(repos: RepoData[], you?: string): SiteData {
  // A person is whoever answers an open question somewhere; work they own counts as theirs. The
  // person with the most open questions comes first, and the hub's filter starts on them.
  const asked = repos.flatMap((r) =>
    r.items
      .filter((i) => i.status === "open" && (i.kind === "decision" || i.kind === "review"))
      .map((i) => firstWord(i.owner)),
  );
  const count = (p: string) => asked.filter((a) => a === p).length;
  const people = [...new Set(asked)].sort((a, b) => count(b) - count(a) || a.localeCompare(b));
  // An owner is a person unless it starts lower-case ("an agent", "a brand session"), with "Agent",
  // or with an agent's name.
  const agents = new Set(repos.flatMap((r) => r.agents));
  const others = [
    ...new Set(
      repos.flatMap((r) =>
        r.items.filter((i) => i.status === "open").map((i) => firstWord(i.owner)),
      ),
    ),
  ]
    .filter(
      (p) => /^\p{Lu}/u.test(p) && p !== "Agent" && !agents.has(p) && p !== (you ?? people[0]),
    )
    .sort();
  const pages: Page[] = [
    { path: "index", type: "hub", title: "Admin hub" },
    { path: "architecture", type: "hub-architecture", title: "Packages" },
  ];
  const out = repos.map((r) => {
    const prefix = `${r.key}/`;
    const items = [...r.items].sort(compareItems).map((i) => {
      const recommendedKeys = [i.recommended ?? []].flat();
      return {
        ...i,
        repo: r.key,
        who: firstWord(i.owner),
        html: itemHtml(r, i.body),
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
        path: `doc/${d.path.replace(/\.md$/i, "")}`,
        type: "doc",
        doc: d.path,
        title: d.title,
      });
    return { ...r, items, prefix, dashboard };
  });
  return { version: VERSION, people, others, repos: out, pages };
}

// Every path is resolved, since the package may sit hoisted or nested.
export function stylesheet() {
  const at = (spec: string) => Bun.resolveSync(spec, PKG);
  const brand = dirname(at("@hackersandwizards/brand/tokens.css"));
  const brandRoot = join(brand, "..");
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
  const existing = existsSync(outDir) ? readdirSync(outDir) : [];
  if (existing.length && !existing.includes("index.html"))
    throw new Error(`${outDir} holds files but no admin build: name an empty or earlier output`);
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
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(dirname(outDir), { recursive: true });
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
