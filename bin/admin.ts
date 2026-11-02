#!/usr/bin/env bun
// Builds the admin pages of the repository it runs in, from its last commit, into
// node_modules/.cache/admin/, and prints the dashboard's path.
// Usage: admin [<repo>] [--out <dir>]
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSite, siteData } from "../src/build.ts";
import { readRepo } from "../src/repo.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
});
const repo = resolve(positionals[0] ?? ".");
const out = resolve(values.out ?? join(repo, "node_modules/.cache/admin"));
const data = readRepo(repo);
await buildSite(siteData([data], false), out);
for (const d of data.defects) console.error(`defect: ${d}`);
console.log(join(out, "index.html"));
