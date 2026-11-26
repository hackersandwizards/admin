import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import type { RepoData } from "../src/repo.ts";
import {
  attemptRepoRead,
  buildUnreadNotices,
  createRepoCache,
  createRepoScanner,
  errorMessageOf,
  isReadDeferred,
  RETRY_MS,
  siteStateKey,
  stateOfRepo,
  type ReadFailure,
  type RepoSnapshot,
} from "../src/serve-repos.ts";
import { commit, scratch, sh } from "./admin-fixtures.ts";

const sampleRepo = (key: string, path: string): RepoData => ({
  key,
  path,
  label: key,
  head: "abc1234",
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

describe("errorMessageOf", () => {
  test.each([
    ["Error instance", new Error("broken repo"), "broken repo"],
    ["plain string", "raw failure", "raw failure"],
    ["number value", 42, "42"],
  ])("formats %s", (_label, input, expected) => {
    expect(errorMessageOf(input)).toBe(expected);
  });
});

describe("siteStateKey", () => {
  test("prefixes the local calendar day ahead of each repository state in order", () => {
    const day = Date.UTC(2026, 4, 10, 12, 0, 0);
    const expectedDay = new Date(day).toDateString();
    expect(
      siteStateKey(
        [
          ["/r/alpha", "s1"],
          ["/r/beta", "s2"],
        ],
        day,
      ),
    ).toBe(`${expectedDay}\n/r/alpha s1\n/r/beta s2`);
  });
});

describe("isReadDeferred", () => {
  const now = 100_000;

  test.each<{ label: string; failed: ReadFailure | undefined; state: string; expected: boolean }>([
    { label: "no prior failure", failed: undefined, state: "s1", expected: false },
    {
      label: "failed at same state within retry window",
      failed: { state: "s2", at: now - RETRY_MS + 1, message: "err" },
      state: "s2",
      expected: true,
    },
    {
      label: "failed at same state at exact retry boundary",
      failed: { state: "s2", at: now - RETRY_MS, message: "err" },
      state: "s2",
      expected: false,
    },
    {
      label: "failed at older state and now moved",
      failed: { state: "s2", at: now - 10, message: "err" },
      state: "s3",
      expected: false,
    },
  ])("$label -> $expected", ({ failed, state, expected }) => {
    expect(isReadDeferred(failed, state, now)).toBe(expected);
  });
});

describe("buildUnreadNotices", () => {
  test("uses prior repo key when previously read, basename otherwise, preserving insertion order", () => {
    const unread = new Map<string, ReadFailure>([
      ["/work/second-dir", { state: "s2", at: 10, message: "missing blob" }],
      ["/work/first-dir", { state: "s1", at: 20, message: "bad head" }],
    ]);
    const read = new Map<string, RepoSnapshot>([
      ["/work/first-dir", { state: "s0", data: sampleRepo("custom-key", "/work/first-dir") }],
    ]);
    expect(buildUnreadNotices(unread, read)).toEqual([
      { name: "second-dir", message: "missing blob", hasLastRead: false },
      { name: "custom-key", message: "bad head", hasLastRead: true },
    ]);
  });
});

describe("attemptRepoRead", () => {
  test("returns ok with data on success", async () => {
    const data = sampleRepo("alpha", "/r/alpha");
    expect(await attemptRepoRead("/r/alpha", async () => data)).toEqual({ ok: true, data });
  });

  test("logs and returns failure message when reading throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await attemptRepoRead("/r/alpha", async () => {
        throw new Error("corrupt pack");
      });
      expect(result).toEqual({ ok: false, message: "corrupt pack" });
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("stateOfRepo", () => {
  test("combines refs, push tip, and fetched marker into the exact state string", async () => {
    const origin = scratch();
    sh(origin, "git", "init", "-q", "-b", "main");
    writeFileSync(join(origin, "README.md"), "# Hi\n");
    sh(origin, "git", "add", "README.md");
    commit(origin, "init");
    const head = sh(origin, "git", "rev-parse", "HEAD").trim();

    const clone = join(scratch(), "clone");
    sh(origin, "git", "clone", "-q", origin, clone);
    sh(clone, "git", "config", "push.default", "current");
    const fetchHead = join(clone, ".git/FETCH_HEAD");
    rmSync(fetchHead, { force: true });

    const refs =
      `${head} HEAD\n` +
      `${head} refs/heads/main\n` +
      `${head} refs/remotes/origin/HEAD\n` +
      `${head} refs/remotes/origin/main\n`;

    expect(await stateOfRepo(clone)).toEqual({
      state: `${refs}\n${head}\n\n`,
      fetched: undefined,
    });

    writeFileSync(fetchHead, "");
    const stamp = new Date(2026, 2, 1, 8, 30);
    utimesSync(fetchHead, stamp, stamp);

    expect(await stateOfRepo(clone)).toEqual({
      state: `${refs}\n${head}\n\nfetched`,
      fetched: stamp.getTime(),
    });
  });
});

describe("createRepoScanner", () => {
  test("caches within rescanMs and returns prior list while rescanning in background", async () => {
    let resolveSecond!: (paths: string[]) => void;
    const second = new Promise<string[]>((r) => (resolveSecond = r));
    const replies = [Promise.resolve(["/r/a"]), second];
    const find = vi.fn(() => replies.shift()!);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const list = createRepoScanner("/r", 500, find);
      expect(await list()).toEqual(["/r/a"]);
      expect(await list()).toEqual(["/r/a"]);
      expect(find).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(1_600);
      expect(await list()).toEqual(["/r/a"]);
      resolveSecond(["/r/a", "/r/b"]);
      await second;
      expect(await list()).toEqual(["/r/a", "/r/b"]);
    } finally {
      clock.mockRestore();
    }
  });

  test("ignores an older slow scan that finishes after a newer scan", async () => {
    let resolveSlow!: (paths: string[]) => void;
    let resolveFast!: (paths: string[]) => void;
    const slow = new Promise<string[]>((r) => (resolveSlow = r));
    const fast = new Promise<string[]>((r) => (resolveFast = r));
    const replies = [Promise.resolve(["/r/initial"]), slow, fast];
    const find = vi.fn(() => replies.shift()!);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const list = createRepoScanner("/r", 100, find);
      await list();
      clock.mockReturnValue(1_200);
      await list();
      clock.mockReturnValue(1_400);
      await list();
      resolveFast(["/r/newest"]);
      await fast;
      resolveSlow(["/r/stale"]);
      await slow;
      expect(await list()).toEqual(["/r/newest"]);
    } finally {
      clock.mockRestore();
    }
  });

  test("retries after an initial scan failure", async () => {
    const replies = [Promise.reject(new Error("scan failed")), Promise.resolve(["/r/ok"])];
    const find = vi.fn(() => replies.shift()!);
    const list = createRepoScanner("/r", 500, find);
    expect(await rejection(list())).toContain("scan failed");
    expect(await list()).toEqual(["/r/ok"]);
  });
});

describe("createRepoCache", () => {
  test("skips retry within the window and retries reading at the window edge", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const dataB = sampleRepo("b", "/r/b");
    const reads = [
      async () => {
        throw new Error("b broken");
      },
      async () => dataB,
    ];
    const readOne = vi.fn(() => reads.shift()!());
    try {
      const cache = createRepoCache(readOne, async () => ({ state: "b1", fetched: undefined }));
      const p1 = await cache.probe(["/r/b"]);
      await cache.load(p1.states);

      clock.mockReturnValue(10_000 + RETRY_MS - 1);
      const within = await cache.probe(["/r/b"]);
      expect(within.due).toBe(false);
      expect(await cache.load(within.states)).toEqual({ repos: [], fresh: false });
      expect(readOne).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(10_000 + RETRY_MS);
      const atEdge = await cache.probe(["/r/b"]);
      expect(atEdge.due).toBe(true);
      expect(await cache.load(atEdge.states)).toEqual({ repos: [dataB], fresh: true });
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("keeps prior data when a later read fails and clears unread when state reverts", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    let currentState = "s1";
    const dataA = sampleRepo("a", "/r/a");
    const reads = [
      async () => dataA,
      async () => {
        throw new Error("temp failure");
      },
    ];
    try {
      const cache = createRepoCache(
        () => reads.shift()!(),
        async () => ({ state: currentState, fetched: undefined }),
      );
      await cache.load((await cache.probe(["/r/a"])).states);
      currentState = "s2";
      const afterFail = await cache.load((await cache.probe(["/r/a"])).states);
      expect(afterFail).toEqual({ repos: [dataA], fresh: false });
      expect(cache.unreadNotices()).toEqual([
        { name: "a", message: "temp failure", hasLastRead: true },
      ]);
      currentState = "s1";
      clock.mockClear();
      const reverted = await cache.probe(["/r/a"]);
      expect(reverted.due).toBe(false);
      expect(cache.unreadNotices()).toEqual([]);
      expect(clock).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  describe("mixed load and pruning", () => {
    const dataA = sampleRepo("a", "/r/a");
    let reads = 0;
    let cache: ReturnType<typeof createRepoCache>;
    let readFetched: (repo: string) => number | undefined;
    let firstLoad: Awaited<ReturnType<ReturnType<typeof createRepoCache>["load"]>>;

    beforeAll(async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const readers = new Map<string, () => Promise<RepoData>>([
        ["/r/a", async () => dataA],
        [
          "/r/b",
          async () => {
            throw new Error("b broken");
          },
        ],
      ]);
      const states = new Map([
        ["/r/a", { state: "a1", fetched: 500 }],
        ["/r/b", { state: "b1", fetched: undefined }],
      ]);
      cache = createRepoCache(
        (p) => {
          reads++;
          return readers.get(p)!();
        },
        async (p) => states.get(p)!,
      );
      try {
        firstLoad = await cache.load((await cache.probe(["/r/a", "/r/b"])).states);
        readFetched = cache.fetchedTime;
      } finally {
        errSpy.mockRestore();
      }
    });

    test("loads healthy repos alongside failures and records unread notice for never-read repo", () => {
      expect(firstLoad).toEqual({ repos: [dataA], fresh: true });
      expect(readFetched("/r/a")).toBe(500);
      expect(cache.unreadNotices()).toEqual([
        { name: "b", message: "b broken", hasLastRead: false },
      ]);
    });

    test("prunes vanished repositories from read, unread, and fetched caches on probe", async () => {
      await cache.probe(["/r/a"]);
      expect(cache.unreadNotices()).toEqual([]);

      await cache.probe([]);
      expect(readFetched("/r/a")).toBeUndefined();

      await cache.load((await cache.probe(["/r/a"])).states);
      expect(reads).toBe(3);
    });
  });
});
