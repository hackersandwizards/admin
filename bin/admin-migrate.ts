#!/usr/bin/env bun
// Converts a repository's GOAL.md (or TODO.md), docs/tracking/decisions/items.js and the review
// folders naming its rows into docs/tracking/items/<id>.md, and deletes the legacy files.
// Usage: admin-migrate --owner <name> [--reviews <dir>] [--dry-run] [<repo> ...]
//   --owner    who answers a row that names no owner, and who decided a row whose text names nobody
//   --reviews  the folder of review topic folders (each with review.json) to move into the spokes
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { migrate } from "../src/migrate.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    owner: { type: "string" },
    reviews: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.owner) {
  console.error("admin-migrate: --owner <name> is required");
  process.exit(2);
}
for (const repo of (positionals.length ? positionals : ["."]).map((r) => resolve(r))) {
  const m = migrate(repo, {
    defaultOwner: values.owner,
    reviews: values.reviews && resolve(values.reviews),
    dryRun: values["dry-run"],
  });
  console.log(
    `${repo}: ${m.written.length} item file(s)${values["dry-run"] ? " (dry run)" : ""}, removed ${m.removed.join(", ") || "nothing"}`,
  );
  for (const p of m.pages) console.log(`  review ${p}`);
  for (const n of m.notes) console.log(`  note: ${n}`);
}
