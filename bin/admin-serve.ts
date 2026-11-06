#!/usr/bin/env bun
// Serves the hub over HTTP, built from every repository's last commit on each request that finds
// one moved, and writes no file. Binds 127.0.0.1 only.
// Usage: admin-serve [--root <dir>] [--port <n>]
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { peerDependencies, peerDependenciesMeta } from "../package.json";
import { stylesheet } from "../src/build.ts";
import { createHub } from "../src/serve.ts";

// Every peer comes from the repository that installs admin: stop with what to pin before the
// first build fails on a missing one, or renders wrong on an optional one older than its range
// (a Git pin, whose range bun does not check).
const missing = Object.entries(peerDependencies).filter(([p, range]) => {
  try {
    const { version } = createRequire(import.meta.url)(`${p}/package.json`);
    return p in peerDependenciesMeta && !Bun.semver.satisfies(version, range);
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(
    `admin-serve: needs ${missing.map(([p, range]) => `${p} ${range}`).join(", ")}. Pin them in this repository's package.json, then run bun install.`,
  );
  process.exit(1);
}
stylesheet();
Bun.resolveSync("@hackersandwizards/scaffolding/catalog/path.ts", import.meta.dir);

const { values } = parseArgs({
  options: { root: { type: "string" }, port: { type: "string" } },
});
const root = resolve(values.root ?? join(homedir(), "dev"));
const hub = createHub({ root });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(values.port ?? 4329),
  fetch: hub.fetch,
});
console.log(`admin-serve: http://admin.localhost:${server.port} (root ${root})`);
