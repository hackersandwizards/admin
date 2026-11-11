#!/usr/bin/env bun
// Serves the hub over HTTP from every repository's HEAD, rebuilt when one moves; writes nothing
// into the repositories it reads.
// Usage: admin-serve [--root <dir>] [--port <n>]
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { peerDependencies } from "../package.json";
import { stylesheet } from "../src/build.ts";
import { createHub } from "../src/serve.ts";

// Stop with what to pin on a peer missing or outside its range: every peer is optional, and bun
// checks no optional peer's range.
const missing = Object.entries(peerDependencies).filter(([p, range]) => {
  try {
    const { version } = createRequire(import.meta.url)(`${p}/package.json`);
    return !Bun.semver.satisfies(version, range);
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
// A newer peer within its range may have moved a file the build reads.
stylesheet();

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
