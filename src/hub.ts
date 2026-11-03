// Finds the repositories the hub shows: every git checkout under a root whose HEAD has
// docs/agent-work/items or whose package.json names a @hackersandwizards package, its own name
// included, without a list of repos. Such a repo shows with zero items.
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ITEMS_DIR } from "./items.ts";
import { git } from "./repo.ts";

const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", "venv", "coverage"]);

export function findRepos(root: string, depth = 6): string[] {
  const found: string[] = [];
  const visit = (dir: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (
      entries.some((e) => e.name === ".git") &&
      (git(dir, "ls-tree", "-d", "HEAD", ITEMS_DIR).trim() ||
        git(dir, "show", "HEAD:package.json").includes('"@hackersandwizards/'))
    )
      found.push(dir);
    if (level < depth)
      for (const e of entries)
        if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
          visit(join(dir, e.name), level + 1);
  };
  visit(root, 0);
  // Clones sharing an origin count once: the one whose .git is a directory, not a worktree link.
  const byOrigin = new Map<string, string>();
  for (const p of found.sort()) {
    const origin = git(p, "config", "--get", "remote.origin.url").trim() || p;
    const had = byOrigin.get(origin);
    if (
      !had ||
      (!statSync(join(had, ".git")).isDirectory() && statSync(join(p, ".git")).isDirectory())
    )
      byOrigin.set(origin, p);
  }
  return [...byOrigin.values()].sort((a, b) => basename(a).localeCompare(basename(b)));
}
