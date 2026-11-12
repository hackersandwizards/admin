// Finds the repositories the hub shows: every git checkout under a root whose HEAD has
// docs/agent-work/items or whose package.json names a @hackersandwizards package, its own name
// included, without a list of repos. Such a repo shows with zero items.
import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ITEMS_DIR } from "./items.ts";
import { asKey, gitAsync, type RepoData } from "./repo.ts";

const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", "venv", "coverage"]);

export async function findRepos(root: string, depth = 6): Promise<string[]> {
  const checkouts: string[] = [];
  // Without blocking: the hub answers requests while a later search runs.
  const visit = async (dir: string, level: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.name === ".git")) checkouts.push(dir);
    if (level < depth)
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
          .map((e) => visit(join(dir, e.name), level + 1)),
      );
  };
  await visit(root, 0);
  checkouts.sort();
  // One process per checkout answers both: the items entry's type, then package.json's text.
  const origins = await Promise.all(
    checkouts.map(async (dir) => {
      const out = await gitAsync(
        dir,
        ["cat-file", "--batch"],
        `HEAD:${ITEMS_DIR}\nHEAD:package.json\n`,
      );
      if (!/^\S+ tree /.test(out) && !out.includes('"@hackersandwizards/')) return undefined;
      return (await gitAsync(dir, ["config", "--get", "remote.origin.url"])).trim() || dir;
    }),
  );
  // Clones sharing an origin count once: the one whose .git is a directory, not a worktree link.
  const byOrigin = new Map<string, string>();
  checkouts.forEach((p, n) => {
    const origin = origins[n];
    if (!origin) return;
    const had = byOrigin.get(origin);
    if (
      !had ||
      (!statSync(join(had, ".git")).isDirectory() && statSync(join(p, ".git")).isDirectory())
    )
      byOrigin.set(origin, p);
  });
  return [...byOrigin.values()].sort((a, b) => basename(a).localeCompare(basename(b)));
}

// Addresses the hub's own pages and routes take.
const RESERVED = new Set(["index", "architecture", "404", "catalog", "_astro", "_file"]);

// Each repository's pages lie under its key, so two checkouts with one key, or a key the hub's own
// addresses take, would show one's data under both: such a key gets its parent folder's name before
// it, and the repository a defect that says so.
export function uniqueKeys(repos: RepoData[]): RepoData[] {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  const used = new Set(repos.map((r) => r.key));
  return repos.map((r) => {
    if (counts.get(r.key) === 1 && !RESERVED.has(r.key)) return r;
    const base = `${asKey(basename(dirname(r.path)))}-${r.key}`;
    let key = base;
    for (let n = 2; used.has(key) || RESERVED.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    const why = RESERVED.has(r.key) ? "names a page of the hub" : "names another checkout too";
    return {
      ...r,
      key,
      label: r.label && `${r.label} (${basename(dirname(r.path))})`,
      defects: [...r.defects, `key ${r.key} ${why}: its pages are under ${key}`],
    };
  });
}
