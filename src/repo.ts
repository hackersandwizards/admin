import { basename } from "node:path";
import { fetchedAt, gitAsync, gitBytes, headSource, readCommits, type Commit } from "./git.ts";
import { ITEMS_DIR, WORK_DIR, type Item } from "./items.ts";
import { readItems, type Source } from "./item-source.ts";
import { extractTitle, renderDocMarkdown } from "./markdown.ts";
import {
  ADMIN_FILE,
  ASTRO_CONFIG,
  readRepoConfig,
  type Link,
  type Product,
} from "./repo-config.ts";
import { IMAGE } from "./repo-paths.ts";

export type Report = Doc & {
  stem: string;
  date: string;
  changed?: number;
  version: string;
};
export type Review = { dir: string; images: string[]; report?: string };
export type Doc = { path: string; title: string; titleId?: string; html: string };
export type ScriptFile = { path: string; comment: string };

export type RepoData = {
  key: string;
  label?: string;
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
const wantsRepoFile = (p: string) =>
  p === "package.json" ||
  p === ADMIN_FILE ||
  ASTRO_CONFIG.test(p) ||
  isDoc(p) ||
  SCRIPT.test(p) ||
  AGENT.test(p);

export function agentDescription(text: string): string {
  try {
    const front = Bun.YAML.parse(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") as {
      description?: unknown;
    } | null;
    return typeof front?.description === "string" ? front.description : "";
  } catch {
    return "";
  }
}

export function firstComment(text: string): string {
  for (const line of text.split("\n", 12)) {
    const m = line.match(/^\s*(?:\/\/|#(?!!)|\/\*+|\*)\s?(.*)/);
    const comment = m?.[1].trimEnd().replace(/\*\/$/, "").trimEnd();
    if (comment) return comment;
  }
  return "";
}

export function parseWorkLog(workLog: string): Map<string, number> {
  const changed = new Map<string, number>();
  let t = 0;
  for (const line of workLog.split("\0").map((entry) => entry.replace(/^\n/, ""))) {
    if (line.startsWith("@")) t = Number(line.slice(1));
    else if (line && !changed.has(line)) changed.set(line, t);
  }
  return changed;
}

export function attachItemChanges(
  items: readonly Item[],
  src: Source,
  changed: ReadonlyMap<string, number>,
): (Item & { changed?: number; version?: string })[] {
  return items.map((i) => {
    const path = `${ITEMS_DIR}/${i.id}.md`;
    return {
      ...i,
      changed: changed.get(path),
      version: Bun.hash(src.read(path) ?? "").toString(36),
    };
  });
}

export function readReports(
  repo: string,
  src: Source,
  changed: ReadonlyMap<string, number>,
): Report[] {
  return src.paths
    .filter((p) => /^docs\/agent-work\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(p))
    .map((p) => {
      const text = src.read(p) ?? "";
      const stem = basename(p, ".md");
      const { title, ...rest } = extractTitle(renderDocMarkdown(repo, p, text));
      return {
        path: p,
        ...rest,
        title: title ?? stem,
        stem,
        date: stem.slice(0, 10),
        changed: changed.get(p),
        version: Bun.hash(text).toString(36),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
}

export function readReviews(paths: readonly string[], reportPaths: ReadonlySet<string>): Review[] {
  const reviewDirs = new Map<string, string[]>();
  for (const p of paths) {
    const m = p.match(/^(docs\/agent-work\/\d{4}-\d{2}-\d{2}-[^/]+)\/(.+)$/);
    if (!m) continue;
    const list = reviewDirs.get(m[1]!) ?? [];
    list.push(m[2]!);
    reviewDirs.set(m[1]!, list);
  }
  return [...reviewDirs]
    .map(([dir, files]) => ({
      dir,
      images: files.filter((f) => IMAGE.test(f)).sort(),
      report: reportPaths.has(`${dir}.md`) ? `${dir}.md` : undefined,
    }))
    .sort((a, b) => b.dir.localeCompare(a.dir));
}

export function readDocs(repo: string, src: Source, reportedPaths: ReadonlySet<string>): Doc[] {
  return src.paths
    .filter((p) => isDoc(p) && !reportedPaths.has(p) && !p.startsWith(`${ITEMS_DIR}/`))
    .map((p) => {
      const { title, ...rest } = extractTitle(renderDocMarkdown(repo, p, src.read(p) ?? ""));
      return { path: p, ...rest, title: title ?? p };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function readScriptFiles(src: Source): ScriptFile[] {
  return src.paths
    .filter((p) => SCRIPT.test(p))
    .map((p) => ({ path: p, comment: firstComment(src.read(p) ?? "") }));
}

export function readAgentNames(src: Source): string[] {
  return src.paths
    .filter((p) => AGENT.test(p))
    .flatMap(
      (p) => agentDescription(src.read(p) ?? "").match(/^(\p{Lu}[\p{L}-]*), who\b/u)?.[1] ?? [],
    );
}

// Every git call of a repository runs at once, and the hub reads its repositories at once.
export async function readRepo(repo: string, source?: Source): Promise<RepoData> {
  const [src, workLog, head, behind, trackingLog, log, fetched] = await Promise.all([
    source ?? headSource(repo, wantsRepoFile),
    gitAsync(repo, ["log", "-z", "--format=@%ct", "--name-only", "--", WORK_DIR]),
    gitAsync(repo, ["rev-parse", "--short", "HEAD"]),
    gitBytes(repo, ["rev-list", "--count", "HEAD..@{push}"]),
    readCommits(repo, ["-n", "60", "--", WORK_DIR]),
    readCommits(repo, ["-n", "60"]),
    fetchedAt(repo),
  ]);
  const { items, defects: itemDefects } = readItems(src);
  const config = readRepoConfig(repo, src);
  const changed = parseWorkLog(workLog);
  const reports = readReports(repo, src, changed);
  const reported = new Set(reports.map((r) => r.path));
  return {
    key: config.key,
    label: config.label,
    path: repo,
    head: head.trim(),
    behind: behind ? Number(behind.toString().trim()) : undefined,
    fetched,
    items: attachItemChanges(items, src, changed),
    defects: [...itemDefects, ...config.defects],
    reports,
    reviews: readReviews(src.paths, reported),
    docs: readDocs(repo, src, reported),
    workFiles: src.paths.filter((p) => p.startsWith(`${WORK_DIR}/`)),
    pkg: config.pkg,
    designSystem: config.designSystem,
    designSystemDev: config.designSystemDev,
    products: config.products,
    links: config.links,
    agents: readAgentNames(src),
    checkSteps: config.checkSteps,
    scripts: readScriptFiles(src),
    trackingLog,
    log,
  };
}
