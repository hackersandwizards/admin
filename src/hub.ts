// Finds the repositories the hub shows: every git checkout under a root whose HEAD has
// docs/agent-work/items or whose package.json names a @hackersandwizards package, its own name
// included, without a list of repos. Such a repo shows with zero items.
import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ITEMS_DIR } from "./items.ts";
import { gitAsync } from "./git.ts";
export { uniqueKeys } from "./repo-keys.ts";

// `_archive` holds retired checkouts, at any depth.
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "venv",
  "coverage",
  "_archive",
]);

async function readCheckoutDirectory(dir: string, isRoot: boolean) {
  try {
    if (isRoot) {
      const info = await stat(dir, { throwIfNoEntry: false });
      if (!info?.isDirectory()) return [];
    }
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return [];
    throw error;
  }
}

export async function findRepos(root: string, depth = 6): Promise<string[]> {
  const checkouts: string[] = [];
  // Without blocking: the hub answers requests while a later search runs.
  const visit = async (dir: string, level: number): Promise<void> => {
    const entries = await readCheckoutDirectory(dir, level === 0);
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
