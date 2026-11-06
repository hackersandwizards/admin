#!/usr/bin/env bun
// Serves the hub over HTTP, built from every repository's last commit on each request that finds
// one moved, and writes no file. Binds 127.0.0.1 only.
// Usage: admin-serve [--root <dir>] [--port <n>]
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { peerDependencies } from "../package.json";
import { stylesheet } from "../src/build.ts";
import { createHub } from "../src/serve.ts";

// Every peer comes from the repository that installs admin: stop with what to pin before the
// first build fails on a missing one.
const missing = Object.keys(peerDependencies).filter((p) => {
  try {
    return !Bun.resolveSync(`${p}/package.json`, import.meta.dir);
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(
    `admin-serve: ${missing.join(", ")} not installed. Pin them in this repository's package.json, then run bun install.`,
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
