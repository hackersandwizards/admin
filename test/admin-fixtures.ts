import { afterAll } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Window } from "happy-dom";
import { gitEnv } from "../src/git.ts";
import { readRepo } from "../src/repo.ts";

export const FIX = join(import.meta.dirname, "fixtures");
const made: string[] = [];
export const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "admin-test-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
export const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe", env: gitEnv });
  if (r.exitCode) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
export const commit = (cwd: string, message: string) =>
  sh(
    cwd,
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    message,
  );
// A repository holding only a package.json with this admin configuration.
export const configured = (dir: string, admin: Record<string, unknown>) =>
  readRepo(dir, {
    paths: ["package.json"],
    read: (p) => (p === "package.json" ? JSON.stringify({ admin }) : undefined),
  });
// A repository read from these files alone, at a path with no checkout.
export const fromFiles = (files: Record<string, string>) =>
  readRepo("/nonexistent/x", { paths: Object.keys(files), read: (f) => files[f] });

export function repoFrom(fixture: string, name = "spoke") {
  const dir = join(scratch(), name);
  cpSync(join(FIX, fixture), dir, { recursive: true });
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "add", "-A");
  commit(dir, "c");
  return dir;
}

export const evaluate = (window: Window, source: string) => {
  // Happy DOM runs scripts in a separate realm from Vitest's mutation coverage hooks.
  const { __stryker__ } = globalThis as typeof globalThis & { __stryker__?: object };
  if (__stryker__) Object.assign(window, { __stryker__ });
  window.eval(source);
};

// Runs a check in another time zone, then restores the process's own, unset included.
export const inZone = <T>(zone: string, check: () => T): T => {
  const tz = process.env.TZ;
  process.env.TZ = zone;
  try {
    return check();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
};
