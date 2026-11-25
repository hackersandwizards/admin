import { basename } from "node:path";
import { fetchedAt, gitAsync } from "./git.ts";
import { findRepos } from "./hub.ts";
import { readRepo, type RepoData } from "./repo.ts";

// A read or build that failed is tried again on a request once this passed, or sooner once a
// repository moves.
export const RETRY_MS = 60_000;

export const errorMessageOf = (e: unknown) => (e as Error).message ?? String(e);

export type RepoSnapshot = { state: string; data: RepoData };
export type ReadFailure = { state: string; at: number; message: string };
export type RepoMemory = { read?: RepoSnapshot; failed?: ReadFailure };
export type RepoReadAction = "keep" | "defer" | "read";
export type UnreadNotice = { name: string; message: string; hasLastRead: boolean };
export type RepoProbe = {
  states: (readonly [string, string])[];
  key: string;
  due: boolean;
};

export interface RepoCache {
  probe(current: readonly string[]): Promise<RepoProbe>;
  load(
    states: readonly (readonly [string, string])[],
  ): Promise<{ repos: RepoData[]; fresh: boolean }>;
  unreadNotices(): UnreadNotice[];
  fetchedTime(repoPath: string): number | undefined;
}

// After the first fetch, stamp() updates the time without a rebuild if the refs and push tip stay put.
export async function stateOfRepo(repo: string) {
  const [refs, pushTip, fetched] = await Promise.all([
    gitAsync(repo, ["show-ref", "--head"]),
    gitAsync(repo, ["rev-parse", "--verify", "--quiet", "@{push}"]),
    fetchedAt(repo),
  ]);
  return { state: [refs, pushTip, fetched ? "fetched" : ""].join("\n"), fetched };
}

// The day is part of the state: a due date comes within a week of it with no commit.
export function siteStateKey(states: readonly (readonly [string, string])[], now: number): string {
  return [new Date(now).toDateString(), ...states.map(([p, s]) => `${p} ${s}`)].join("\n");
}

export function decideRepoRead(memory: RepoMemory, state: string, now: number): RepoReadAction {
  if (memory.read?.state === state) return "keep";
  if (memory.failed?.state === state && now - memory.failed.at < RETRY_MS) return "defer";
  return "read";
}

// The first request waits for the search; a later one keeps the last result while the next
// search runs.
export function createRepoScanner(
  root: string,
  rescanMs = 300_000,
  find: (dir: string) => Promise<string[]> = findRepos,
) {
  let paths: Promise<string[]> | undefined;
  let scanned = 0;
  let scanning: Promise<string[]> | undefined;

  return async function listRepos(): Promise<string[]> {
    if (!paths || Date.now() - scanned > rescanMs) {
      scanned = Date.now();
      const next = (scanning = find(root));
      if (paths)
        next.then(() => {
          // Only the latest search replaces the list, should an earlier one finish after it.
          if (scanning === next) paths = next;
        }, console.error);
      else (paths = next).catch(() => (paths = undefined));
    }
    return await paths;
  };
}

function pruneMap<V>(map: Map<string, V>, current: readonly string[]) {
  for (const p of map.keys()) if (!current.includes(p)) map.delete(p);
}

export function buildUnreadNotices(
  unread: ReadonlyMap<string, ReadFailure>,
  read: ReadonlyMap<string, RepoSnapshot>,
): UnreadNotice[] {
  return [...unread].map(([p, u]) => {
    const had = read.get(p);
    return {
      name: had?.data.key ?? basename(p),
      message: u.message,
      hasLastRead: had !== undefined,
    };
  });
}

export async function attemptRepoRead(
  repoPath: string,
  readOne: (repo: string) => Promise<RepoData>,
): Promise<{ ok: true; data: RepoData } | { ok: false; message: string }> {
  try {
    return { ok: true, data: await readOne(repoPath) };
  } catch (e) {
    console.error(`admin-serve: ${repoPath}:`, e);
    return { ok: false, message: errorMessageOf(e) };
  }
}

class RepoStore implements RepoCache {
  readonly #read = new Map<string, RepoSnapshot>();
  // Each repository's fetch time as the latest request found it.
  readonly #fetchedNow = new Map<string, number | undefined>();
  readonly #unread = new Map<string, ReadFailure>();
  readonly #readOne: (repo: string) => Promise<RepoData>;
  readonly #readState: (repo: string) => Promise<{ state: string; fetched: number | undefined }>;

  constructor(
    readOne: (repo: string) => Promise<RepoData>,
    readState: (repo: string) => Promise<{ state: string; fetched: number | undefined }>,
  ) {
    this.#readOne = readOne;
    this.#readState = readState;
  }

  async probe(current: readonly string[]): Promise<RepoProbe> {
    // A repository gone from the search keeps no entry: its failed read would stay in the notice.
    pruneMap(this.#read, current);
    pruneMap(this.#unread, current);
    pruneMap(this.#fetchedNow, current);
    const states = await Promise.all(
      current.map(async (p) => {
        const { state, fetched } = await this.#readState(p);
        this.#fetchedNow.set(p, fetched);
        return [p, state] as const;
      }),
    );
    const now = Date.now();
    // Back at the state of its last read, a failed read since then no longer applies.
    for (const [p, s] of states) if (this.#read.get(p)?.state === s) this.#unread.delete(p);
    const due = [...this.#unread.values()].some((u) => now - u.at >= RETRY_MS);
    return { states, key: siteStateKey(states, now), due };
  }

  // A repository that fails to read keeps its last pages, or is left out.
  async #loadOne(p: string, s: string): Promise<{ data: RepoData | undefined; fresh: boolean }> {
    const had = this.#read.get(p);
    if (decideRepoRead({ read: had, failed: this.#unread.get(p) }, s, Date.now()) !== "read")
      return { data: had?.data, fresh: false };
    const result = await attemptRepoRead(p, this.#readOne);
    if (result.ok) {
      this.#read.set(p, { state: s, data: result.data });
      this.#unread.delete(p);
      return { data: result.data, fresh: true };
    }
    this.#unread.set(p, { state: s, at: Date.now(), message: result.message });
    return { data: had?.data, fresh: false };
  }

  async load(states: readonly (readonly [string, string])[]) {
    const results = await Promise.all(states.map(([p, s]) => this.#loadOne(p, s)));
    return {
      repos: results.flatMap((r) => (r.data ? [r.data] : [])),
      fresh: results.some((r) => r.fresh),
    };
  }

  unreadNotices(): UnreadNotice[] {
    return buildUnreadNotices(this.#unread, this.#read);
  }

  readonly fetchedTime = (repoPath: string): number | undefined => this.#fetchedNow.get(repoPath);
}

export function createRepoCache(
  readOne: (repo: string) => Promise<RepoData> = readRepo,
  readState: (
    repo: string,
  ) => Promise<{ state: string; fetched: number | undefined }> = stateOfRepo,
): RepoCache {
  return new RepoStore(readOne, readState);
}
