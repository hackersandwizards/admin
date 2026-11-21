import { basename, dirname } from "node:path";
import { asKey } from "./repo-paths.ts";
import type { RepoData } from "./repo.ts";

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
