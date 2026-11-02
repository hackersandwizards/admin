#!/usr/bin/env bun
// Serves the hub over HTTP, built from every repository's last commit on each request that finds
// one moved, and writes no file. Binds 127.0.0.1 only.
// Usage: admin-serve [--root <dir>] [--port <n>]
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHub } from "../src/serve.ts";

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
