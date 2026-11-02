#!/usr/bin/env bun
// Checks a repository's item files in docs/tracking/items (fields, status, options, images and
// image folders) from the working tree, and fails while a legacy GOAL.md or items.js remains.
// Usage: admin-check [<repo> ...]   default: the current directory. Exit 1 on a defect.
import { resolve } from "node:path";
import { readItems, treeSource } from "../src/repo.ts";

const repos = process.argv.slice(2).length ? process.argv.slice(2) : ["."];
let defects = 0;
for (const repo of repos.map((r) => resolve(r))) {
  const { items, defects: found } = readItems(treeSource(repo));
  for (const d of found) console.error(`${repo}: ${d}`);
  defects += found.length;
  if (!found.length) console.log(`ok: ${items.length} item(s) in ${repo}`);
}
process.exit(defects ? 1 : 0);
