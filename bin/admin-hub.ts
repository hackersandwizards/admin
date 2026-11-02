#!/usr/bin/env bun
// Builds the hub: every git repository under the root (default ~/dev) that has docs/tracking/items,
// each read at its last commit, as one page across all plus every repository's admin pages.
// Clones sharing an origin count once; dot folders are not entered. Writes ~/dev/.admin/.
// Usage: admin-hub [--root <dir>] [--out <dir>]
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSite, siteData } from "../src/build.ts";
import { findRepos } from "../src/hub.ts";
import { readRepo } from "../src/repo.ts";

const { values } = parseArgs({
  options: { root: { type: "string" }, out: { type: "string" } },
});
const root = resolve(values.root ?? join(homedir(), "dev"));
const out = resolve(values.out ?? join(root, ".admin"));
const repos = findRepos(root).map((p) => readRepo(p));
if (!repos.length) {
  console.error(`admin-hub: no repository with docs/tracking/items under ${root}`);
  process.exit(1);
}
await buildSite(siteData(repos, true), out);
for (const r of repos) for (const d of r.defects) console.error(`${r.key}: ${d}`);
console.log(`${join(out, "index.html")}: ${repos.map((r) => r.key).join(", ")}`);
