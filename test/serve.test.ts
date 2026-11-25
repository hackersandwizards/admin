import { describe, expect, test, vi } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import type { RepoData } from "../src/repo.ts";
import {
  BuildError,
  createHub,
  createSiteStore,
  decideSiteBuild,
  loadSiteForFile,
  type BuildFailure,
  type SiteBuildAction,
} from "../src/serve.ts";
import { linker, type Site } from "../src/serve-pages.ts";
import { createRepoCache, RETRY_MS } from "../src/serve-repos.ts";
import { scratch } from "./admin-fixtures.ts";

function throwOnBuildSpawn(error: Error) {
  const spawn = Bun.spawn;
  const spy = vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts: object) => {
    if (cmd[1]?.endsWith("serve.ts")) throw error;
    return spawn(cmd, opts as never);
  }) as typeof Bun.spawn);
  return () => spy.mockRestore();
}

const makeRepo = (key: string, path: string): RepoData => ({
  key,
  path,
  label: key,
  head: "abc123",
  items: [],
  reports: [],
  reviews: [],
  docs: [],
  workFiles: [],
  scripts: [],
  agents: [],
  products: [],
  links: [],
  checkSteps: [],
  defects: [],
  trackingLog: [],
  log: [],
  pkg: { dependencies: {}, scripts: {}, bin: {} },
});

const makeSite = (key: string, repos: RepoData[]): Site => ({
  key,
  built: 1_000,
  files: new Map(),
  repos,
  links: linker(repos),
  docs: new Map(),
  shells: new Map(),
  filled: new Map(),
});

describe("decideSiteBuild", () => {
  const now = 200_000;
  const recentFailure: BuildFailure = {
    key: "k2",
    at: now - RETRY_MS + 1,
    message: "build failed: boom",
    isBuildError: true,
  };
  const expiredFailure: BuildFailure = {
    key: "k2",
    at: now - RETRY_MS,
    message: "build failed: boom",
    isBuildError: true,
  };

  test.each<{
    label: string;
    current: { siteKey?: string; failed?: BuildFailure };
    target: { key: string; fresh: boolean };
    expected: SiteBuildAction;
  }>([
    { label: "initial build", current: {}, target: { key: "k1", fresh: false }, expected: "build" },
    {
      label: "matching site key with no fresh repo",
      current: { siteKey: "k1" },
      target: { key: "k1", fresh: false },
      expected: "reuse",
    },
    {
      label: "matching site key with fresh repo read",
      current: { siteKey: "k1" },
      target: { key: "k1", fresh: true },
      expected: "build",
    },
    {
      label: "settled failure with existing site keeps stale site",
      current: { siteKey: "k1", failed: recentFailure },
      target: { key: "k2", fresh: false },
      expected: "reuse",
    },
    {
      label: "settled failure without any site rethrows",
      current: { failed: recentFailure },
      target: { key: "k2", fresh: false },
      expected: "rethrow",
    },
    {
      label: "expired failure retries build",
      current: { siteKey: "k1", failed: expiredFailure },
      target: { key: "k2", fresh: false },
      expected: "build",
    },
    {
      label: "settled failure rebuilds early when a repo became fresh",
      current: { siteKey: "k1", failed: recentFailure },
      target: { key: "k2", fresh: true },
      expected: "build",
    },
  ])("$label -> $expected", ({ current, target, expected }) => {
    expect(decideSiteBuild(current, target, now)).toBe(expected);
  });
});

describe("createSiteStore", () => {
  test("rethrows BuildError during retry window on initial failure and clears failure once build succeeds", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(50_000);
    const repo = makeRepo("a", "/r/a");
    const repoCache = createRepoCache(
      async () => repo,
      async () => ({ state: "s1", fetched: undefined }),
    );
    const outcomes = [
      async () => {
        throw new BuildError("build failed: exit 1");
      },
      async (key: string, repos: RepoData[]) => makeSite(key, repos),
    ];
    const build = vi.fn((key: string, repos: RepoData[]) => outcomes.shift()!(key, repos));
    try {
      const store = createSiteStore(async () => ["/r/a"], repoCache, build);
      expect(await rejection(store.refresh())).toContain("build failed: exit 1");
      const cachedErr = await store.refresh().catch((e: unknown) => e);
      expect(cachedErr).toBeInstanceOf(BuildError);
      expect(build).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(50_000 + RETRY_MS);
      const built = await store.refresh();
      expect(built.repos).toEqual([repo]);
      expect(store.buildFailure()).toBeUndefined();
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("keeps the previous site on rebuild failure and records buildFailure with builtAt", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    let state = "s1";
    const repo = makeRepo("a", "/r/a");
    const repoCache = createRepoCache(
      async () => repo,
      async () => ({ state, fetched: undefined }),
    );
    const outcomes = [
      async (key: string, repos: RepoData[]) => makeSite(key, repos),
      async () => {
        throw new BuildError("build failed: TypeError: boom");
      },
    ];
    const build = vi.fn((key: string, repos: RepoData[]) => outcomes.shift()!(key, repos));
    try {
      const store = createSiteStore(async () => ["/r/a"], repoCache, build);
      const first = await store.refresh();
      state = "s2";
      clock.mockReturnValue(20_000);
      expect(await store.refresh()).toBe(first);
      expect(store.buildFailure()).toEqual({
        at: 20_000,
        message: "build failed: TypeError: boom",
        builtAt: 1_000,
      });
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });
});

describe("loadSiteForFile", () => {
  test("returns the existing site without loading, absorbs BuildError, and rethrows unexpected errors", async () => {
    const existing = makeSite("k1", []);
    const load = vi.fn(async () => existing);
    expect(await loadSiteForFile(() => existing, load)).toBe(existing);
    expect(load).not.toHaveBeenCalled();

    expect(
      await loadSiteForFile(
        () => undefined,
        async () => {
          throw new BuildError("build failed: exit 1");
        },
      ),
    ).toBeUndefined();

    const unexpected = await rejection(
      loadSiteForFile(
        () => undefined,
        async () => {
          throw new TypeError("unexpected bug");
        },
      ),
    );
    expect(unexpected).toContain("unexpected bug");
  });
});

describe("cold-start /_file/ error handling", () => {
  test("propagates unexpected errors from pages() instead of swallowing them into 404", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = throwOnBuildSpawn(new TypeError("spawn denied"));
    try {
      const hub = createHub({ root: scratch() });
      const err = await rejection(
        hub.fetch(new Request("http://admin.localhost/_file/spoke/README.md")),
      );
      expect(err).toContain("spawn denied");
    } finally {
      restore();
      errSpy.mockRestore();
    }
  });
});
