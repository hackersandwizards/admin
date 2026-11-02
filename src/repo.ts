// Reads one repository for its admin pages: at HEAD (what the hub and `admin` show, committed only)
// or from the working tree (what `admin-check` validates in a gate).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ITEMS_DIR, ItemError, itemDefects, parseItem, type Item } from "./items.ts";

export const LEGACY = ["docs/tracking/decisions/items.js", "GOAL.md"];

export type Source = { paths: string[]; read: (path: string) => string | undefined };

// A hook exports GIT_DIR, GIT_INDEX_FILE and the like, which would point every git call at the
// repository running the hook, whatever -C names. Each call gets the environment without them.
export const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
) as Record<string, string>;

export const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore", env: gitEnv });
  return r.exitCode === 0 ? r.stdout.toString() : "";
};

export function headSource(repo: string): Source {
  const paths = git(repo, "ls-tree", "-r", "--name-only", "-z", "HEAD").split("\0").filter(Boolean);
  const cache = new Map<string, string>();
  const wanted = paths.filter(
    (p) =>
      p === "package.json" ||
      ASTRO_CONFIG.test(p) ||
      (/\.md$/i.test(p) && (p.startsWith("docs/") || !p.includes("/"))) ||
      /^(scripts|bin)\/.+\.(ts|js|mjs|sh|py)$/.test(p),
  );
  // One cat-file process for every text file the pages read.
  const batch = Bun.spawnSync(["git", "-C", repo, "cat-file", "--batch"], {
    env: gitEnv,
    stdin: Buffer.from(wanted.map((p) => `HEAD:${p}`).join("\n") + "\n"),
  }).stdout;
  let at = 0;
  for (const p of wanted) {
    const nl = batch.indexOf(10, at);
    const head = batch.subarray(at, nl).toString();
    const size = Number(head.split(" ")[2]);
    if (Number.isNaN(size)) {
      at = nl + 1;
      continue;
    }
    cache.set(p, batch.subarray(nl + 1, nl + 1 + size).toString());
    at = nl + 1 + size + 1;
  }
  return { paths, read: (p) => cache.get(p) };
}

export function treeSource(repo: string): Source {
  const listed = git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const paths = (
    listed
      ? listed.split("\0").filter(Boolean)
      : walk(repo, "").filter((p) => !p.startsWith("node_modules/"))
  ).filter((p) => existsSync(join(repo, p)));
  return {
    paths,
    read: (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : undefined),
  };
}

function walk(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.name === ".git" || e.name === "node_modules") return [];
    return e.isDirectory() ? walk(root, p) : [p];
  });
}

export type ReadItems = { items: Item[]; defects: string[] };

export function readItems(src: Source): ReadItems {
  const items: Item[] = [];
  const defects: string[] = [];
  const has = new Set(src.paths);
  // A path is present as a file or as the folder of one.
  const exists = (p: string) =>
    has.has(p) || src.paths.some((q) => q.startsWith(p.replace(/\/?$/, "/")));
  for (const p of src.paths) {
    if (!p.startsWith(`${ITEMS_DIR}/`)) continue;
    const name = p.slice(ITEMS_DIR.length + 1);
    // An item's images sit in a folder named for it; the folder goes with the item.
    const [folder, file, deeper] = name.split("/");
    if (file && !deeper && IMAGE.test(file)) {
      if (!has.has(`${ITEMS_DIR}/${folder}.md`)) defects.push(`${p}: no item ${folder}.md`);
      continue;
    }
    if (name.includes("/") || !name.endsWith(".md")) {
      defects.push(`${p}: only <id>.md files and <id>/<image> belong in ${ITEMS_DIR}`);
      continue;
    }
    try {
      const item = parseItem(name.slice(0, -3), src.read(p) ?? "");
      for (const d of itemDefects(item, exists)) defects.push(`${p}: ${d}`);
      items.push(item);
    } catch (e) {
      if (!(e instanceof ItemError)) throw e;
      defects.push(`${p}: ${e.message}`);
    }
  }
  for (const p of LEGACY)
    if (has.has(p)) defects.push(`${p}: legacy file, items live in ${ITEMS_DIR}`);
  return { items, defects };
}

export type Report = { path: string; date: string; title: string; html: string };
export type Review = { dir: string; images: string[]; report?: string };
export type Doc = { path: string; title: string; html: string };
export type ScriptFile = { path: string; comment: string };
export type Commit = { hash: string; time: number; subject: string };
export type Link = { label: string; href: string };
export type Product = { label: string; href: string; description?: string };

export type RepoData = {
  key: string;
  path: string;
  head: string;
  behind: number;
  fetched?: number;
  items: (Item & { changed?: number })[];
  defects: string[];
  reports: Report[];
  reviews: Review[];
  docs: Doc[];
  pkg: {
    name?: string;
    version?: string;
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
    bin: Record<string, string>;
  };
  designSystem?: string;
  // The dev server the design system runs on, when it is this repository's own Astrobook.
  designSystemDev?: { port: number; start?: string };
  products: Product[];
  links: Link[];
  checkSteps: string[];
  scripts: ScriptFile[];
  trackingLog: Commit[];
  log: Commit[];
};

const ASTRO_CONFIG = /^([^/]+\/)?astro\.config\.(ts|mjs|js)$/;
const IMAGE = /\.(jpe?g|png|gif|webp|svg|avif)$/i;
export const fileHref = (abs: string) => "file://" + encodeURI(abs).replace(/#/g, "%23");

// Rendered Markdown wears brand's shared elements.
export const withElements = (html: string) =>
  html
    .replace(/<table>/g, '<table class="hw-table">')
    .replace(/<blockquote>/g, '<blockquote class="hw-quote">')
    .replace(/<a href=/g, '<a class="hw-link" href=');

// A Markdown file as HTML; relative src and href resolve to the file in the spoke.
export function renderMarkdown(repo: string, path: string, text: string) {
  const dir = join(repo, path, "..");
  const html = withElements(Bun.markdown.html(text.replace(/^---\n[\s\S]*?\n---\n/, "")));
  return html.replace(/(src|href)="(?![a-z][\w+.-]*:|#|\/)([^"]+)"/gi, (_, attr, rel) => {
    return `${attr}="${fileHref(join(dir, decodeURI(rel)))}"`;
  });
}

const firstHeading = (text: string, fallback: string) =>
  text.match(/^# (.+)$/m)?.[1]?.trim() ?? fallback;

// The first comment line of a script: its purpose, by this codebase's convention.
function firstComment(text: string) {
  for (const line of text.split("\n").slice(0, 12)) {
    const m = line.match(/^\s*(?:\/\/|#(?!!)|\/\*+|\*)\s?(.*?)\s*(?:\*\/)?$/);
    if (m && m[1]) return m[1];
  }
  return "";
}

// Where a repository's catalog runs in development: the astro config at the root or one folder
// down that loads astrobook or scaffolding's catalog preset (Astrobook at /catalog), read for its
// server port, base and subpath, and the package script that starts it: `catalog` where the
// preset's repository has one.
function astrobookDev(src: Source, scripts: Record<string, string>) {
  for (const p of src.paths.filter((q) => ASTRO_CONFIG.test(q))) {
    const text = src.read(p) ?? "";
    const preset = text.includes("@hackersandwizards/scaffolding/catalog");
    const port =
      preset || text.includes("astrobook") ? text.match(/\bport:\s*(\d+)/)?.[1] : undefined;
    if (!port) continue;
    const at = (key: string) => text.match(new RegExp(`\\b${key}:\\s*["']([^"']+)["']`))?.[1];
    const path = `${at("base") ?? ""}${at("subpath") ?? (preset ? "/catalog" : "")}`.replace(
      /\/*$/,
      "/",
    );
    const dir = p.includes("/") ? p.slice(0, p.indexOf("/")) : "";
    const runs = Object.keys(scripts).filter((k) => {
      const v = scripts[k]!;
      return v.includes("astro dev") && (dir ? v.includes(dir) : !/--root|\bcd /.test(v));
    });
    const start =
      (preset && scripts.catalog ? "catalog" : undefined) ??
      runs.find((k) => k.includes("design")) ??
      runs.find((k) => k === "dev") ??
      runs[0];
    return { url: `http://127.0.0.1:${port}${path}`, port: Number(port), start };
  }
}

type AdminConfig = { name?: string; designSystem?: string; products?: Product[]; links?: Link[] };

export function readRepo(repo: string, src: Source = headSource(repo)): RepoData {
  const { items, defects } = readItems(src);
  const pkgText = src.read("package.json");
  let pkg: Record<string, unknown> = {};
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {};
  } catch {
    defects.push("package.json: not JSON");
  }
  const admin = (pkg.admin ?? {}) as AdminConfig;
  const key = admin.name ?? basename(repo);
  const scriptsMap = (pkg.scripts ?? {}) as Record<string, string>;
  // A repository-relative href opens the committed file; one with a scheme stays as written.
  const href = (h: string) => {
    if (/^[a-z][\w+.-]*:/i.test(h)) return h;
    const [path, hash] = h.split("#");
    return fileHref(join(repo, path!)) + (hash ? `#${hash}` : "");
  };
  // admin.designSystem wins; otherwise the repository's own catalog, else no entry.
  const dev = astrobookDev(src, scriptsMap);
  const designSystem = admin.designSystem ? href(admin.designSystem) : dev?.url;
  const designSystemDev =
    dev && designSystem === dev.url ? { port: dev.port, start: dev.start } : undefined;

  // When each item file last changed, from one log pass over the items folder.
  const changed = new Map<string, number>();
  let t = 0;
  for (const line of git(repo, "log", "--format=@%ct", "--name-only", "--", ITEMS_DIR).split(
    "\n",
  )) {
    if (line.startsWith("@")) t = Number(line.slice(1));
    else if (line && !changed.has(line)) changed.set(line, t);
  }
  const withChange = items.map((i) => ({ ...i, changed: changed.get(`${ITEMS_DIR}/${i.id}.md`) }));

  const tracking = src.paths.filter(
    (p) => p.startsWith("docs/tracking/") && !p.startsWith(`${ITEMS_DIR}/`),
  );
  const reports = tracking
    .filter((p) => /^docs\/tracking\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(p))
    .map((p) => {
      const text = src.read(p) ?? "";
      return {
        path: p,
        date: basename(p).slice(0, 10),
        title: firstHeading(text, basename(p, ".md")),
        html: renderMarkdown(repo, p, text),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
  const reviewDirs = new Map<string, string[]>();
  for (const p of tracking) {
    const m = p.match(/^(docs\/tracking\/\d{4}-\d{2}-\d{2}-[^/]+)\/(.+)$/);
    if (!m) continue;
    const list = reviewDirs.get(m[1]!) ?? [];
    list.push(m[2]!);
    reviewDirs.set(m[1]!, list);
  }
  const reviews = [...reviewDirs]
    .map(([dir, files]) => ({
      dir,
      images: files.filter((f) => IMAGE.test(f)).sort(),
      report: reports.some((r) => r.path === `${dir}.md`) ? `${dir}.md` : undefined,
    }))
    .sort((a, b) => b.dir.localeCompare(a.dir));
  const docs = src.paths
    .filter(
      (p) =>
        /\.md$/i.test(p) &&
        (p.startsWith("docs/") || !p.includes("/")) &&
        !reports.some((r) => r.path === p) &&
        !p.startsWith(`${ITEMS_DIR}/`),
    )
    .map((p) => {
      const text = src.read(p) ?? "";
      return { path: p, title: firstHeading(text, p), html: renderMarkdown(repo, p, text) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const check = scriptsMap["check:all"] ?? scriptsMap.check ?? "";
  const checkSteps = check
    .split(/\s*&&\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const scripts = src.paths
    .filter((p) => /^(scripts|bin)\/.+\.(ts|js|mjs|sh|py)$/.test(p))
    .map((p) => ({ path: p, comment: firstComment(src.read(p) ?? "") }));

  const commits = (...a: string[]) =>
    git(repo, "log", "--format=%h%x09%ct%x09%s", ...a)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, time, ...s] = l.split("\t");
        return { hash: hash!, time: Number(time), subject: s.join("\t") };
      });

  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  return {
    key,
    path: repo,
    head: git(repo, "rev-parse", "--short", "HEAD").trim(),
    behind: Number(git(repo, "rev-list", "--count", "HEAD..@{u}").trim() || 0),
    fetched: existsSync(fetchHead) ? statSync(fetchHead).mtimeMs : undefined,
    items: withChange,
    defects,
    reports,
    reviews,
    docs,
    pkg: {
      name: pkg.name as string | undefined,
      version: pkg.version as string | undefined,
      dependencies: {
        ...((pkg.dependencies ?? {}) as Record<string, string>),
        ...((pkg.devDependencies ?? {}) as Record<string, string>),
      },
      scripts: scriptsMap,
      bin: (typeof pkg.bin === "string"
        ? { [String(pkg.name)]: pkg.bin }
        : (pkg.bin ?? {})) as Record<string, string>,
    },
    designSystem,
    designSystemDev,
    products: (admin.products ?? []).map((p) => ({ ...p, href: href(p.href) })),
    links: (admin.links ?? []).map((l) => ({ ...l, href: href(l.href) })),
    checkSteps,
    scripts,
    trackingLog: commits("-n", "60", "--", "docs/tracking"),
    log: commits("-n", "60"),
  };
}
