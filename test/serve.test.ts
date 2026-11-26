import { assert, describe, expect, test, vi } from "vitest";
import { defined } from "@hackersandwizards/scaffolding/defined";
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
    isBuildError: true,
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
  test("logs an Error instance with the literal message and Bun output on build failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = makeRepo("a", "/r/a");
    const repoCache = createRepoCache(
      async () => repo,
      async () => ({ state: "s1", fetched: undefined }),
    );
    const store = createSiteStore(
      async () => ["/r/a"],
      repoCache,
      async () => {
        throw new BuildError("build failed: exit 1");
      },
    );
    try {
      const rejected = await rejection(store.refresh());
      const logged: unknown = defined(errSpy.mock.calls[0], "first logged error")[0];
      expect(rejected).toBe("Error: build failed: exit 1");
      expect(logged).toBeInstanceOf(Error);
      expect((logged as Error).name).toBe("Error");
      expect((logged as Error).message).toBe("build failed: exit 1");
      expect(Bun.inspect(logged).split("\n")).toContain("error: build failed: exit 1");
    } finally {
      errSpy.mockRestore();
    }
  });

  test.each([
    {
      label: "build failure -> fresh BuildError",
      thrown: new BuildError("build failed: exit 1"),
      expectedConstructor: BuildError,
      expectedMessage: "build failed: exit 1",
    },
    {
      label: "other failure -> fresh plain Error",
      thrown: new TypeError("unexpected boom"),
      expectedConstructor: Error,
      expectedMessage: "unexpected boom",
    },
  ])("deferred refresh: $label", async ({ thrown, expectedConstructor, expectedMessage }) => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(50_000);
    const repo = makeRepo("a", "/r/a");
    const repoCache = createRepoCache(
      async () => repo,
      async () => ({ state: "s1", fetched: undefined }),
    );
    const build = vi.fn(async () => {
      throw thrown;
    });
    try {
      const store = createSiteStore(async () => ["/r/a"], repoCache, build);
      const [initial] = await Promise.allSettled([store.refresh()]);
      assert(initial.status === "rejected", "the failing build should reject");

      const [first] = await Promise.allSettled([store.refresh()]);
      assert(first.status === "rejected", "first deferred call should reject");
      const err1 = first.reason as Error;
      const message1 = err1.message;
      err1.message = "mutated by caller";

      const [second] = await Promise.allSettled([store.refresh()]);
      assert(second.status === "rejected", "second deferred call should reject");
      const err2 = second.reason as Error;
      expect(Object.getPrototypeOf(err1)).toBe(expectedConstructor.prototype);
      expect(Object.getPrototypeOf(err2)).toBe(expectedConstructor.prototype);
      expect([message1, err2.message]).toEqual([expectedMessage, expectedMessage]);
      expect(new Set([initial.reason, err1, err2]).size).toBe(3);
      expect(build).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("returns the built repositories and clears buildFailure once retry succeeds", async () => {
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
    const build = vi.fn((key: string, repos: RepoData[]) =>
      defined(outcomes.shift(), "next build outcome")(key, repos),
    );
    try {
      const store = createSiteStore(async () => ["/r/a"], repoCache, build);
      await rejection(store.refresh());
      clock.mockReturnValue(50_000 + RETRY_MS);
      const built = await store.refresh();
      expect(built.repos).toEqual([repo]);
      expect(store.buildFailure()).toBeUndefined();
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("rebuilds when fresh repository data arrives despite matching site key", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repoA = makeRepo("a", "/r/a");
    const repoB = makeRepo("b", "/r/b");
    const bReads = [
      async () => {
        throw new Error("b transient");
      },
      async () => repoB,
    ];
    const readers = new Map<string, () => Promise<RepoData>>([
      ["/r/a", async () => repoA],
      ["/r/b", () => defined(bReads.shift(), "next repository B read")()],
    ]);
    const repoCache = createRepoCache(
      (p) => defined(readers.get(p), `repository reader for ${p}`)(),
      async (p) => ({ state: `state:${p}`, fetched: undefined }),
    );
    const build = vi.fn(async (key: string, repos: RepoData[]) => makeSite(key, repos));
    try {
      const store = createSiteStore(async () => ["/r/a", "/r/b"], repoCache, build);
      const first = await store.refresh();
      expect(first.repos).toEqual([repoA]);

      clock.mockReturnValue(10_000 + RETRY_MS);
      const rebuilt = await store.refresh();
      expect(rebuilt).not.toBe(first);
      expect(rebuilt.repos).toEqual([repoA, repoB]);
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("rebuilds during build backoff when fresh repository data arrives", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const repoA = makeRepo("a", "/r/a");
    const repoB = makeRepo("b", "/r/b");
    const bReads = [
      async () => {
        throw new Error("b transient");
      },
      async () => repoB,
    ];
    const readers = new Map<string, () => Promise<RepoData>>([
      ["/r/a", async () => repoA],
      ["/r/b", () => defined(bReads.shift(), "next repository B read")()],
    ]);
    const states = new Map([
      ["/r/a", "a1"],
      ["/r/b", "b1"],
    ]);
    const repoCache = createRepoCache(
      (p) => defined(readers.get(p), `repository reader for ${p}`)(),
      async (p) => ({
        state: defined(states.get(p), `repository state for ${p}`),
        fetched: undefined,
      }),
    );
    const outcomes = [
      async (key: string, repos: RepoData[]) => makeSite(key, repos),
      async () => {
        throw new BuildError("build failed: boom");
      },
      async (key: string, repos: RepoData[]) => makeSite(key, repos),
    ];
    const build = vi.fn((key: string, repos: RepoData[]) =>
      defined(outcomes.shift(), "next build outcome")(key, repos),
    );
    try {
      const store = createSiteStore(async () => ["/r/a", "/r/b"], repoCache, build);
      const first = await store.refresh();
      // Move a to a2 at t=50_000 so build fails and starts a 60s build backoff.
      states.set("/r/a", "a2");
      clock.mockReturnValue(50_000);
      expect(await store.refresh()).toBe(first);
      // At t=70_000, build backoff is still active (20s elapsed), while b's read is due (60s elapsed).
      clock.mockReturnValue(70_000);
      const rebuilt = await store.refresh();
      expect(rebuilt).not.toBe(first);
      expect(rebuilt.repos).toEqual([repoA, repoB]);
      expect(build).toHaveBeenCalledTimes(3);
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
    const build = vi.fn((key: string, repos: RepoData[]) =>
      defined(outcomes.shift(), "next build outcome")(key, repos),
    );
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
