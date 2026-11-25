import { describe, expect, test, vi } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import type { RepoData } from "../src/repo.ts";
import {
  BuildError,
  createHub,
  createSiteStore,
  isBuildDeferred,
  loadSiteForFile,
  type BuildFailure,
} from "../src/serve.ts";
import type { Site } from "../src/serve-pages.ts";
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
  docs: new Map(),
  docPage: () => undefined,
});

describe("isBuildDeferred", () => {
  const now = 200_000;
  const failure = (at: number): BuildFailure => ({
    key: "k2",
    at,
    message: "build failed: boom",
    error: new BuildError("build failed: boom"),
  });

  test.each<{ label: string; failed: BuildFailure | undefined; key: string; expected: boolean }>([
    { label: "no prior failure", failed: undefined, key: "k1", expected: false },
    {
      label: "matching key within retry window",
      failed: failure(now - RETRY_MS + 1),
      key: "k2",
      expected: true,
    },
    {
      label: "matching key at exact retry boundary",
      failed: failure(now - RETRY_MS),
      key: "k2",
      expected: false,
    },
    {
      label: "different key within retry window",
      failed: failure(now - 10),
      key: "k3",
      expected: false,
    },
  ])("$label -> $expected", ({ failed, key, expected }) => {
    expect(isBuildDeferred(failed, key, now)).toBe(expected);
  });
});

describe("BuildError", () => {
  test("preserves Error name, message, and console formatting", () => {
    const err = new BuildError("build failed: TypeError: boom");
    expect(err.name).toBe("Error");
    expect(err.message).toBe("build failed: TypeError: boom");
    expect(String(err)).toBe("Error: build failed: TypeError: boom");
    expect(Bun.inspect(err).split("\n")).toContain("error: build failed: TypeError: boom");
  });
});

describe("createSiteStore", () => {
  test("logs Error line, rethrows BuildError during retry window, and clears failure on recovery", async () => {
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
      expect(String(errSpy.mock.calls[0]![0])).toBe("Error: build failed: exit 1");
      const cachedErr = await store.refresh().catch((e: unknown) => e);
      expect(cachedErr).toBeInstanceOf(BuildError);
      expect(build).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(50_000 + RETRY_MS);
      await store.refresh();
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
      expect(await store.refresh()).toBe(first);
      expect(build).toHaveBeenCalledTimes(2);
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

  test("rethrows plain Error (not BuildError) during retry window after a non-BuildError failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repo = makeRepo("a", "/r/a");
    const repoCache = createRepoCache(
      async () => repo,
      async () => ({ state: "s1", fetched: undefined }),
    );
    const build = vi.fn(async () => {
      throw new TypeError("unexpected boom");
    });
    try {
      const store = createSiteStore(async () => ["/r/a"], repoCache, build);
      await rejection(store.refresh());
      const cached = await store.refresh().catch((e: unknown) => e);
      expect(cached).toBeInstanceOf(Error);
      expect(cached).not.toBeInstanceOf(BuildError);
      expect((cached as Error).message).toBe("unexpected boom");
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
