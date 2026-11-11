import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  ITEMS_DIR,
  WORK_DIR,
  ItemError,
  itemDefects,
  parseItem,
  usable,
  type Item,
} from "./items.ts";

const LEGACY = ["GOAL.md"];

// A key is letters, digits, ".", "_" and "-", never only dots: a slash, a dot segment or one
// percent-encoded would write pages outside the build, a "?" or "#" breaks its addresses, and
// admin.js reads the repository of an answer's key up to its first colon. A folder's name keeps
// its other characters as "-".
export const asKey = (folder: string) => folder.replace(/[^\w.-]/g, "-");

export type Source = { paths: string[]; read: (path: string) => string | undefined };

// A hook exports GIT_DIR, GIT_INDEX_FILE and the like, which point git at the hook's repository
// whatever -C names.
export const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
) as Record<string, string>;

export const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore", env: gitEnv });
  return r.exitCode === 0 ? r.stdout.toString() : "";
};

// The same without blocking, so that many repositories are asked at once, as bytes or as text.
export async function gitBytes(cwd: string, args: string[], stdin = "") {
  const r = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: stdin ? Buffer.from(stdin) : "ignore",
    stderr: "ignore",
    env: gitEnv,
  });
  const out = Buffer.from(await new Response(r.stdout).arrayBuffer());
  return (await r.exited) === 0 ? out : undefined;
}

export const gitAsync = async (cwd: string, args: string[], stdin = "") =>
  (await gitBytes(cwd, args, stdin))?.toString() ?? "";

// A git call that fails throws, so a repository that cannot be read never shows as an empty one.
async function headSource(repo: string): Promise<Source> {
  const listed = await gitBytes(repo, ["ls-tree", "-r", "-z", "HEAD"]);
  if (!listed) throw new Error("git ls-tree HEAD failed");
  // "<mode> <type> <object>\t<path>": the batch asks by object, so a path holding a newline reads
  // too, and a submodule, which is no file here, is left out.
  const entries = listed
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf("\t");
      const [, type, oid] = e.slice(0, tab).split(" ");
      return { path: e.slice(tab + 1), type, oid: oid! };
    })
    .filter((e) => e.type === "blob");
  const paths = entries.map((e) => e.path);
  const cache = new Map<string, string>();
  const wanted = entries.filter(
    ({ path: p }) =>
      p === "package.json" || ASTRO_CONFIG.test(p) || isDoc(p) || SCRIPT.test(p) || AGENT.test(p),
  );
  const batch = await gitBytes(
    repo,
    ["cat-file", "--batch"],
    wanted.map((e) => e.oid).join("\n") + "\n",
  );
  if (!batch) throw new Error("git cat-file failed");
  let at = 0;
  for (const { path: p } of wanted) {
    const nl = batch.indexOf(10, at);
    const head = batch.subarray(at, nl).toString();
    const size = Number(head.split(" ")[2]);
    if (Number.isNaN(size)) throw new Error(`git cat-file answered "${head}"`);
    cache.set(p, batch.subarray(nl + 1, nl + 1 + size).toString());
    at = nl + 1 + size + 1;
  }
  return { paths, read: (p) => cache.get(p) };
}

export function treeSource(repo: string): Source {
  const listed = git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const paths = (listed ? listed.split("\0").filter(Boolean) : walk(repo, "")).filter((p) =>
    existsSync(join(repo, p)),
  );
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
  // An image is a file: a folder of that name has no picture to show.
  const exists = (p: string) => has.has(p);
  for (const p of src.paths) {
    if (!p.startsWith(`${ITEMS_DIR}/`)) continue;
    const name = p.slice(ITEMS_DIR.length + 1);
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
      items.push(usable(item));
    } catch (e) {
      if (!(e instanceof ItemError)) throw e;
      defects.push(`${p}: ${e.message}`);
    }
  }
  for (const p of LEGACY)
    if (has.has(p)) defects.push(`${p}: legacy file, items live in ${ITEMS_DIR}`);
  // The folder was renamed: a file left at the old path would vanish from every page unnoticed.
  for (const p of src.paths)
    if (p.startsWith("docs/tracking/")) defects.push(`${p}: legacy folder, move it to ${WORK_DIR}`);
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
  // Commits the upstream has that HEAD lacks, unknown without an upstream.
  behind?: number;
  fetched?: number;
  // When an item file last changed in a commit, and its text as a version a browser compares.
  items: (Item & { changed?: number; version?: string })[];
  defects: string[];
  reports: Report[];
  reviews: Review[];
  docs: Doc[];
  // Every file under docs/agent-work, which a path in an item links to.
  workFiles: string[];
  pkg: {
    name?: string;
    version?: string;
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
    bin: Record<string, string>;
  };
  designSystem?: string;
  designSystemDev?: { port: number; start?: string };
  products: Product[];
  links: Link[];
  // The name each agent definition gives its colleague: "Ada, who runs ..." in its description.
  agents: string[];
  checkSteps: string[];
  scripts: ScriptFile[];
  trackingLog: Commit[];
  log: Commit[];
};

const AGENT = /^\.claude\/agents\/[^/]+\.md$/;
const SCRIPT = /^(scripts|bin)\/.+\.(ts|js|mjs|sh|py)$/;
// A Markdown file at the root or under docs/: a report or a doc, unless an item file.
const isDoc = (p: string) => /\.md$/i.test(p) && (p.startsWith("docs/") || !p.includes("/"));
const description = (text: string) => {
  try {
    const front = Bun.YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") as {
      description?: unknown;
    } | null;
    return typeof front?.description === "string" ? front.description : "";
  } catch {
    return "";
  }
};
const ASTRO_CONFIG = /^([^/]+\/)?astro\.config\.(ts|mjs|js)$/;
const IMAGE = /\.(jpe?g|png|gif|webp|svg|avif)$/i;
// A page path ending in "index" is its folder's own route to Astro, so index.md keeps its extension.
export const docSlug = (path: string) =>
  `doc/${/(^|\/)index\.md$/i.test(path) ? path : path.replace(/\.md$/i, "")}`;

// A moment as a reader names it, "10 Nov, 09:05", in the machine's time zone.
export const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
// "#" or "?" would end the path, and an "&" or "'" left as is comes out of the pages' attributes escaped,
// where the hub's link rewriting no longer finds it.
export const encodeFile = (path: string) =>
  encodeURI(path).replace(/[#?&']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const fileHref = (abs: string) => "file://" + encodeFile(abs);
// A path whose every segment is encoded, so a "#", "%" or "?" in a name stays in its path.
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

// What admin-serve resizes a committed image to: a review tile's 16:9 box (the page's aspect-video),
// and twice it for a 2x screen.
export const THUMB_BOXES = [
  [480, 270],
  [960, 540],
] as const;
// The attributes of an <img> showing the linked file smaller; the browser picks from the laid-out width.
export const thumbnail = (href: string) => ({
  src: `${href}?w=${THUMB_BOXES[0][0]}`,
  srcset: THUMB_BOXES.map(([w]) => `${href}?w=${w} ${w}w`).join(", "),
  sizes: "auto, 50vw",
});

const plain = (html: string) =>
  html
    .replace(/<[^<>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

// brand's tableScroll (elements/table.ts) takes a hast tree: this is the same step on Bun's HTML
// string, held to brand's names by a test. Entities stay encoded, which the attribute decodes. A
// table holding another is left to the inner one, so no wrapper closes inside a cell; a raw table
// with attributes is wrapped as written. A tag ends before the next "<", so an unclosed one costs
// no scan to the end of the text.
function tableScroll(html: string) {
  let title = "";
  let under = 0;
  return html.replace(
    /<(h[1-6])\b[^<>]*>((?:(?!<h[1-6]\b)[\s\S])*?)<\/\1>|<table\b([^<>]*)>((?:(?!<table\b)[\s\S])*?<\/table>)/gi,
    (all, h: string | undefined, heading: string, attrs: string, table: string) => {
      if (h) {
        [title, under] = [plain(heading), 0];
        return all;
      }
      if (title) under++;
      const name = title
        ? under > 1
          ? `${title} (${under})`
          : title
        : [
            ...table
              .split(/<\/tr>/i, 1)[0]!
              .matchAll(/<t[hd]\b[^<>]*>((?:(?!<t[hd]\b)[\s\S])*?)<\/t[hd]>/gi),
          ]
            .map(([, cell]) => plain(cell!))
            .filter(Boolean)
            .join(" ");
      const region = name ? ` role="region" aria-label="${name.replaceAll('"', "&quot;")}"` : "";
      return `<div class="hw-table-scroll" tabindex="0"${region}><table${attrs || ' class="hw-table not-prose"'}>${table}</div>`;
    },
  );
}

// brand's prose block asks for tables, quotes and code blocks to be not-prose. A link keeps hw-link
// for an item's text, which no prose block holds. A task list gets no marker beside its checkboxes,
// and its boxes are brand's read-only hw-check, a state shown rather than a control, each in a
// <label> with its line's text up to the next block, which names the box; a loose item's label sits
// inside its <p>. The text stops before the next <input, so a run of them costs no rescan each.
// A <meta> tag shows as text, since csp() in serve.ts cannot stop its refresh. The opening is
// escaped rather than the attributes matched, which quoting would defeat.
export const withElements = (html: string) =>
  tableScroll(html.replace(/<meta(?=[\s/>])/gi, "&lt;meta"))
    .replace(/<blockquote>/g, '<blockquote class="hw-quote not-prose">')
    .replace(/<a href=/g, '<a class="hw-link" href=')
    .replace(/<ul>(?!\s*<li class="task-list-item")/g, '<ul class="hw-marker-list">')
    .replace(
      /<input type="checkbox" class="task-list-item-checkbox"([^<>]*)>(\n<p>)?((?:(?!<input)[\s\S])*?)(?=<\/p>|\n<(?:[uo]l|blockquote|pre|table|hr|div|h[1-6]|p)\b|<\/li>|<input)/g,
      (_, attrs: string, p = "", text: string) =>
        `${p}<label><input type="checkbox" class="task-list-item-checkbox hw-check" data-readonly${attrs}>${text}</label>`,
    )
    .replace(/<pre>/g, '<pre class="hw-code not-prose">')
    .replace(/(?<!<pre[^>]*>)<code>/g, '<code class="hw-inline-code">');

// Front matter is a leading YAML mapping between --- lines; a leading rule renders, since "---"
// above a paragraph is no mapping. An item's body has no front matter and no HTML: a placeholder
// such as <id> shows as written, and an address in angle brackets is linked by the pages.
export function renderMarkdown(repo: string, path: string, text: string, item = false) {
  const dir = join(repo, path, "..");
  const body = !item
    ? text.replace(/^---\n([\s\S]*?)\n---\n/, (all, yaml: string) => {
        try {
          return isObject(Bun.YAML.parse(yaml)) ? "" : all;
        } catch {
          return all;
        }
      })
    : text;
  const html = withElements(
    Bun.markdown.html(body, item ? { noHtmlSpans: true, noHtmlBlocks: true } : {}),
  );
  return html.replace(
    /(src|href)="(?![a-z][\w+.-]*:|#|\/)([^"?#]*)((?:[?#][^"]*)?)"/gi,
    (_, attr, rel: string, rest: string) => {
      let path = rel;
      try {
        path = decodeURIComponent(rel);
      } catch {
        // A stray % in a hand-written link stays as written.
      }
      return `${attr}="${fileHref(join(dir, path))}${rest}"`;
    },
  );
}

// A page's title is its first rendered h1, which leaves the article since the title shows above it.
function titled(repo: string, path: string, text: string, fallback: string) {
  const html = renderMarkdown(repo, path, text);
  // From the first <h1 on: an unanchored search would scan to the end once per <h1.
  const h1 = html.slice(Math.max(html.indexOf("<h1"), 0)).match(/^<h1[^>]*>([\s\S]*?)<\/h1>\n?/);
  // Bun's renderer decodes every other entity itself.
  const title =
    h1?.[1] &&
    plain(h1[1]).replace(
      /&(quot|lt|gt|amp);/g,
      (_, e: string) => ({ quot: '"', lt: "<", gt: ">", amp: "&" })[e]!,
    );
  // An h1 without text, such as a lone image, stays in the article.
  if (!h1 || !title) return { path, title: fallback, html };
  return { path, title, html: html.replace(h1[0], "") };
}

function firstComment(text: string) {
  for (const line of text.split("\n", 12)) {
    const m = line.match(/^\s*(?:\/\/|#(?!!)|\/\*+|\*)\s?(.*)/);
    const comment = m?.[1].trimEnd().replace(/\*\/$/, "").trimEnd();
    if (comment) return comment;
  }
  return "";
}

function astrobookDev(src: Source, scripts: Record<string, string>) {
  for (const p of src.paths.filter((q) => ASTRO_CONFIG.test(q))) {
    const text = src.read(p) ?? "";
    const preset = text.includes("@hackersandwizards/scaffolding/catalog");
    const port =
      preset || text.includes("astrobook") ? text.match(/\bport:\s*(\d+)/)?.[1] : undefined;
    if (!port) continue;
    const at = (key: string) => text.match(new RegExp(`\\b${key}:\\s*["']([^"']+)["']`))?.[1];
    // The preset answers /catalog/ wherever its catalog sits, forwarding a home catalog to its
    // root; dev drops the base.
    const path = preset
      ? "/catalog/"
      : `${at("base") ?? ""}${at("subpath") ?? ""}`.replace(/\/*$/, "/");
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// Config entries without a text label and href are dropped rather than failing the whole hub.
const linked = <T extends { label: unknown; href: unknown }>(list: T[] | undefined) =>
  (Array.isArray(list) ? list : []).filter(
    (e) => typeof e?.label === "string" && typeof e?.href === "string",
  );

type AdminConfig = { name?: string; designSystem?: string; products?: Product[]; links?: Link[] };

// When the repository was last fetched: its FETCH_HEAD's time, which a worktree keeps in its own
// git folder rather than in <repo>/.git.
const fetchHeads = new Map<string, Promise<string>>();
export async function fetchedAt(repo: string) {
  let path = fetchHeads.get(repo);
  if (!path) {
    path = gitAsync(repo, ["rev-parse", "--git-path", "FETCH_HEAD"]).then((p) =>
      p.trim() ? resolve(repo, p.trim()) : "",
    );
    fetchHeads.set(repo, path);
  }
  const file = await path;
  // A failed call is asked again next time, rather than kept.
  if (!file) fetchHeads.delete(repo);
  return file && existsSync(file) ? statSync(file).mtimeMs : undefined;
}

// Every git call of a repository runs at once, and the hub reads its repositories at once.
export async function readRepo(repo: string, source?: Source): Promise<RepoData> {
  const commits = async (...a: string[]) =>
    (await gitAsync(repo, ["log", "--format=%h%x09%ct%x09%s", ...a]))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, time, ...s] = l.split("\t");
        return { hash: hash!, time: Number(time), subject: s.join("\t") };
      });
  const [src, itemsLog, head, behind, trackingLog, log, fetched] = await Promise.all([
    source ?? headSource(repo),
    gitAsync(repo, ["log", "--format=@%ct", "--name-only", "--", ITEMS_DIR]),
    gitAsync(repo, ["rev-parse", "--short", "HEAD"]),
    // Without an upstream the count fails: the distance is unknown, not zero.
    gitBytes(repo, ["rev-list", "--count", "HEAD..@{u}"]),
    commits("-n", "60", "--", WORK_DIR),
    commits("-n", "60"),
    fetchedAt(repo),
  ]);
  const { items, defects } = readItems(src);
  const pkgText = src.read("package.json");
  let pkg: Record<string, unknown> = {};
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {};
  } catch {
    defects.push("package.json: not JSON");
  }
  if (!isObject(pkg)) {
    defects.push("package.json: not an object");
    pkg = {};
  }
  // A field of the wrong type is a defect, never a failed build of every repository's pages.
  const texts = (field: string) => {
    const value = pkg[field] ?? {};
    const entries = isObject(value) ? Object.entries(value) : [];
    const kept = entries.filter(([, v]) => typeof v === "string");
    if (!isObject(value) || kept.length < entries.length)
      defects.push(`package.json: ${field} holds a value that is not text`);
    return Object.fromEntries(kept) as Record<string, string>;
  };
  const admin = (isObject(pkg.admin) ? pkg.admin : {}) as AdminConfig;
  const named = typeof admin.name === "string" ? admin.name : undefined;
  const key = named && /^(?!\.+$)[\w.-]+$/.test(named) ? named : asKey(basename(repo));
  if (named !== undefined && key !== named)
    defects.push(
      `package.json: admin.name "${named}" is not letters, digits, ".", "_" and "-": its pages are under ${key}`,
    );
  const scriptsMap = texts("scripts");
  const href = (h: string) => {
    if (/^[a-z][\w+.-]*:/i.test(h)) return h;
    const [, path, rest] = h.match(/^([^?#]*)(.*)$/s)!;
    return fileHref(join(repo, path!)) + rest;
  };
  const dependencies = { ...texts("dependencies"), ...texts("devDependencies") };
  const dev = astrobookDev(src, scriptsMap);
  const designSystem = typeof admin.designSystem === "string" ? href(admin.designSystem) : dev?.url;
  const designSystemDev =
    dev && designSystem === dev.url ? { port: dev.port, start: dev.start } : undefined;

  const changed = new Map<string, number>();
  let t = 0;
  for (const line of itemsLog.split("\n")) {
    if (line.startsWith("@")) t = Number(line.slice(1));
    else if (line && !changed.has(line)) changed.set(line, t);
  }
  const withChange = items.map((i) => {
    const path = `${ITEMS_DIR}/${i.id}.md`;
    return {
      ...i,
      changed: changed.get(path),
      version: Bun.hash(src.read(path) ?? "").toString(36),
    };
  });

  const tracking = src.paths.filter(
    (p) => p.startsWith(`${WORK_DIR}/`) && !p.startsWith(`${ITEMS_DIR}/`),
  );
  const reports = tracking
    .filter((p) => /^docs\/agent-work\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(p))
    .map((p) => {
      const page = titled(repo, p, src.read(p) ?? "", basename(p, ".md"));
      return { ...page, date: basename(p).slice(0, 10) };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
  const reviewDirs = new Map<string, string[]>();
  for (const p of tracking) {
    const m = p.match(/^(docs\/agent-work\/\d{4}-\d{2}-\d{2}-[^/]+)\/(.+)$/);
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
  const reported = new Set(reports.map((r) => r.path));
  const docs = src.paths
    .filter((p) => isDoc(p) && !reported.has(p) && !p.startsWith(`${ITEMS_DIR}/`))
    .map((p) => titled(repo, p, src.read(p) ?? "", p))
    .sort((a, b) => a.path.localeCompare(b.path));

  const check = scriptsMap["check:all"] ?? scriptsMap.check ?? "";
  const checkSteps = check
    .split(/\s*&&\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const scripts = src.paths
    .filter((p) => SCRIPT.test(p))
    .map((p) => ({ path: p, comment: firstComment(src.read(p) ?? "") }));

  return {
    key,
    path: repo,
    head: head.trim(),
    behind: behind ? Number(behind.toString().trim()) : undefined,
    fetched,
    items: withChange,
    defects,
    reports,
    reviews,
    docs,
    workFiles: src.paths.filter((p) => p.startsWith(`${WORK_DIR}/`)),
    pkg: {
      name: typeof pkg.name === "string" ? pkg.name : undefined,
      version: typeof pkg.version === "string" ? pkg.version : undefined,
      dependencies,
      scripts: scriptsMap,
      bin: typeof pkg.bin === "string" ? { [String(pkg.name)]: pkg.bin } : texts("bin"),
    },
    designSystem,
    designSystemDev,
    products: linked(admin.products).map((p) => ({ ...p, href: href(p.href) })),
    links: linked(admin.links).map((l) => ({ ...l, href: href(l.href) })),
    agents: src.paths
      .filter((p) => AGENT.test(p))
      .flatMap(
        (p) => description(src.read(p) ?? "").match(/^(\p{Lu}[\p{L}-]*), who\b/u)?.[1] ?? [],
      ),
    checkSteps,
    scripts,
    trackingLog,
    log,
  };
}
