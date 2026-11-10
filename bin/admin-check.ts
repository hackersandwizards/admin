#!/usr/bin/env bun
// Checks a repository's item files in docs/agent-work/items (fields, status, options, images and
// image folders) from the working tree, and fails while a legacy GOAL.md or items.js remains.
// Usage: admin-check [<repo> ...]   default: the current directory. Exit 1 on a defect.
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORK_DIR } from "../src/items.ts";
import { git, readItems, treeSource } from "../src/repo.ts";

const repos = process.argv.slice(2).length ? process.argv.slice(2) : ["."];
let defects = 0;
for (const repo of repos.map((r) => resolve(r))) {
  // Paths are read relative to the folder named, so a subfolder of a repository would pass with
  // none of its items; a folder holding docs/agent-work of its own, such as a fixture, is checked.
  const top = existsSync(repo) ? git(repo, "rev-parse", "--show-toplevel").trim() : "";
  const problem = !existsSync(repo)
    ? "no such folder"
    : top && realpathSync(top) !== realpathSync(repo) && !existsSync(join(repo, WORK_DIR))
      ? `not the repository's root, which is ${top}`
      : "";
  if (problem) {
    console.error(`${repo}: ${problem}`);
    defects++;
    continue;
  }
  const { items, defects: found } = readItems(treeSource(repo));
  for (const d of found) console.error(`${repo}: ${d}`);
  defects += found.length;
  if (!found.length) console.log(`ok: ${items.length} item(s) in ${repo}`);
}
process.exit(defects ? 1 : 0);
