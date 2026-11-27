import { basename } from "node:path";
import { headSource, readGitMetadata, type Commit } from "./git.ts";
import { ITEMS_DIR, WORK_DIR, type Item } from "./items.ts";
import { readItems, type Source } from "./item-source.ts";
import { extractTitle, renderDocMarkdown } from "./markdown.ts";
import { parseYamlFrontmatter } from "./parse-text.ts";
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
type Review = { dir: string; images: string[]; report?: string };
export type Doc = { path: string; title: string; titleId?: string; html: string };
type ScriptFile = { path: string; comment: string };

export type RepoData = {
  key: string;
  label?: string;
  path: string;
  head: string;
  // Commits on the configured push branch that HEAD lacks, if the comparison succeeds.
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
const isDoc = (p: string) => /\.md$/i.test(p) && (p.startsWith("docs/") || !p.includes("/"));
export const wantsRepoFile = (p: string) =>
  p === "package.json" ||
  p === ADMIN_FILE ||
  ASTRO_CONFIG.test(p) ||
  isDoc(p) ||
  SCRIPT.test(p) ||
  AGENT.test(p);

export function agentDescription(text: string): string {
  const yaml = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (yaml === undefined) return "";
  const front = parseYamlFrontmatter(yaml);
  if (typeof front !== "object" || front === null || !("description" in front)) return "";
  return typeof front.description === "string" ? front.description : "";
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
      const extracted = extractTitle(renderDocMarkdown(repo, p, text));
      const base =
        extracted.title === undefined
          ? { path: p, title: stem, html: extracted.html }
          : { path: p, title: extracted.title, titleId: extracted.titleId, html: extracted.html };
      return {
        ...base,
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
    const [, dir, file] = m;
    const list = reviewDirs.get(dir) ?? [];
    list.push(file);
    reviewDirs.set(dir, list);
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
      const extracted = extractTitle(renderDocMarkdown(repo, p, src.read(p) ?? ""));
      return extracted.title === undefined
        ? { path: p, title: p, html: extracted.html }
        : { path: p, title: extracted.title, titleId: extracted.titleId, html: extracted.html };
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

export async function readRepo(repo: string, source?: Source): Promise<RepoData> {
  const [src, gitMeta] = await Promise.all([
    source ?? headSource(repo, wantsRepoFile),
    readGitMetadata(repo, WORK_DIR),
  ]);
  const { items, defects: itemDefects } = readItems(src);
  const config = readRepoConfig(repo, src);
  const changed = parseWorkLog(gitMeta.workLog);
  const withChange = attachItemChanges(items, src, changed);
  const reports = readReports(repo, src, changed);
  const reported = new Set(reports.map((r) => r.path));
  const docs = readDocs(repo, src, reported);
  const scripts = readScriptFiles(src);
  const agents = readAgentNames(src);
  return {
    key: config.key,
    label: config.label,
    path: repo,
    head: gitMeta.head,
    behind: gitMeta.behind,
    fetched: gitMeta.fetched,
    items: withChange,
    defects: [...itemDefects, ...config.defects],
    reports,
    reviews: readReviews(src.paths, reported),
    docs,
    workFiles: src.paths.filter((p) => p.startsWith(`${WORK_DIR}/`)),
    pkg: config.pkg,
    designSystem: config.designSystem,
    designSystemDev: config.designSystemDev,
    products: config.products,
    links: config.links,
    agents,
    checkSteps: config.checkSteps,
    scripts,
    trackingLog: gitMeta.trackingLog,
    log: gitMeta.log,
  };
}
