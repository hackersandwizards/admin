import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import type { RepoData } from "../src/repo.ts";
import {
  attemptRepoRead,
  buildUnreadNotices,
  createRepoCache,
  createRepoScanner,
  decideRepoRead,
  errorMessageOf,
  RETRY_MS,
  siteStateKey,
  stateOfRepo,
  type ReadFailure,
  type RepoMemory,
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

describe("decideRepoRead", () => {
  const snap: RepoSnapshot = { state: "s1", data: sampleRepo("alpha", "/r/alpha") };
  const now = 100_000;

  test.each<{ label: string; memory: RepoMemory; state: string; at: number; expected: string }>([
    { label: "never read", memory: {}, state: "s1", at: now, expected: "read" },
    {
      label: "unchanged since last read",
      memory: { read: snap },
      state: "s1",
      at: now,
      expected: "keep",
    },
    {
      label: "moved since last read",
      memory: { read: snap },
      state: "s2",
      at: now,
      expected: "read",
    },
    {
      label: "failed at same state within retry window",
      memory: { failed: { state: "s2", at: now - RETRY_MS + 1, message: "err" } },
      state: "s2",
      at: now,
      expected: "defer",
    },
    {
      label: "failed at same state at exact retry boundary",
      memory: { failed: { state: "s2", at: now - RETRY_MS, message: "err" } },
      state: "s2",
      at: now,
      expected: "read",
    },
    {
      label: "failed at older state and now moved",
      memory: { failed: { state: "s2", at: now - 10, message: "err" } },
      state: "s3",
      at: now,
      expected: "read",
    },
    {
      label: "returned to last read state despite recent failure at another state",
      memory: { read: snap, failed: { state: "s2", at: now - 10, message: "err" } },
      state: "s1",
      at: now,
      expected: "keep",
    },
  ])("$label -> $expected", ({ memory, state, at, expected }) => {
    expect(decideRepoRead(memory, state, at)).toBe(expected);
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
  test("includes refs and marks whether FETCH_HEAD exists", async () => {
    const repo = scratch();
    sh(repo, "git", "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# Hi\n");
    sh(repo, "git", "add", "README.md");
    commit(repo, "init");

    const before = await stateOfRepo(repo);
    expect(before.fetched).toBeUndefined();
    expect(before.state.endsWith("\n")).toBe(true);

    const fetchHead = join(repo, ".git/FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const stamp = new Date(2026, 2, 1, 8, 30);
    utimesSync(fetchHead, stamp, stamp);

    const after = await stateOfRepo(repo);
    expect(after.fetched).toBe(stamp.getTime());
    expect(after.state.endsWith("\nfetched")).toBe(true);
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
  test("reads new states, keeps cached data on failure, retries when due, and prunes vanished repos", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const states = new Map<string, { state: string; fetched: number | undefined }>([
      ["/r/a", { state: "a1", fetched: 500 }],
      ["/r/b", { state: "b1", fetched: undefined }],
    ]);
    const dataA = sampleRepo("a", "/r/a");
    const readers = new Map<string, () => Promise<RepoData>>([
      ["/r/a", async () => dataA],
      [
        "/r/b",
        async () => {
          throw new Error("b broken");
        },
      ],
    ]);
    try {
      const cache = createRepoCache(
        (p) => readers.get(p)!(),
        async (p) => states.get(p)!,
      );
      const firstProbe = await cache.probe(["/r/a", "/r/b"]);
      const firstLoad = await cache.load(firstProbe.states);
      expect(firstLoad).toEqual({ repos: [dataA], fresh: true });
      expect(cache.fetchedTime("/r/a")).toBe(500);
      expect(cache.unreadNotices()).toEqual([
        { name: "b", message: "b broken", hasLastRead: false },
      ]);

      clock.mockReturnValue(10_000 + RETRY_MS);
      const retryProbe = await cache.probe(["/r/a", "/r/b"]);
      expect(retryProbe.due).toBe(true);

      await cache.probe(["/r/a"]);
      expect(cache.unreadNotices()).toEqual([]);
    } finally {
      errSpy.mockRestore();
      clock.mockRestore();
    }
  });

  test("clears unread failure when a repository returns to its last successfully read state", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
      await cache.load((await cache.probe(["/r/a"])).states);
      expect(cache.unreadNotices()).toEqual([
        { name: "a", message: "temp failure", hasLastRead: true },
      ]);
      currentState = "s1";
      await cache.probe(["/r/a"]);
      expect(cache.unreadNotices()).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
