import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Source } from "./item-source.ts";

export type Commit = { hash: string; time: number; subject: string };

// A hook exports GIT_DIR, GIT_INDEX_FILE and the like, which point git at the hook's repository
// whatever -C names.
export const cleanGitEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_"))) as Record<
    string,
    string
  >;

export const gitEnv = cleanGitEnv(process.env);

export const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore", env: gitEnv });
  return r.exitCode === 0 ? r.stdout.toString() : "";
};

export async function gitBytes(cwd: string, args: string[], stdin = "") {
  const r = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: stdin ? Buffer.from(stdin) : "ignore",
    stderr: "ignore",
    env: gitEnv,
  });
  const out = Buffer.from(await new Response(r.stdout).arrayBuffer());
  return (await r.exited) === 0 ? out : undefined;
}

export const gitAsync = async (cwd: string, args: string[], stdin = "") =>
  (await gitBytes(cwd, args, stdin))?.toString() ?? "";

// "<mode> <type> <object>\t<path>": the batch asks by object, so a path holding a newline reads
// too, and a submodule, which is no file here, is left out.
export function parseTreeBlobs(listed: Buffer): { path: string; oid: string }[] {
  return listed
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf("\t");
      const [, type, oid] = row.slice(0, tab).split(" ");
      return { path: row.slice(tab + 1), type, oid, row };
    })
    .filter((e) => e.type === "blob")
    .map(({ path, oid, row }) => {
      if (!oid) throw new Error(`Git blob object ID missing: ${JSON.stringify(row)}`);
      return { path, oid };
    });
}

export function parseBatchBlobs(batch: Buffer, paths: readonly string[]): Map<string, string> {
  const cache = new Map<string, string>();
  let at = 0;
  for (const p of paths) {
    const nl = batch.indexOf(10, at);
    const head = batch.subarray(at, nl).toString();
    const size = Number(head.split(" ")[2]);
    if (Number.isNaN(size)) throw new Error(`git cat-file answered "${head}"`);
    cache.set(p, batch.subarray(nl + 1, nl + 1 + size).toString());
    at = nl + 1 + size + 1;
  }
  return cache;
}

// A git call that fails throws, so a repository that cannot be read never shows as an empty one.
export async function headSource(repo: string, want: (path: string) => boolean): Promise<Source> {
  const listed = await gitBytes(repo, ["ls-tree", "-r", "-z", "HEAD"]);
  if (!listed) throw new Error("git ls-tree HEAD failed");
  const entries = parseTreeBlobs(listed);
  const wanted = entries.filter(({ path }) => want(path));
  const batch = await gitBytes(
    repo,
    ["cat-file", "--batch"],
    wanted.map((e) => e.oid).join("\n") + "\n",
  );
  if (!batch) throw new Error("git cat-file failed");
  const cache = parseBatchBlobs(
    batch,
    wanted.map((e) => e.path),
  );
  return { paths: entries.map((e) => e.path), read: (p) => cache.get(p) };
}

function walkTree(root: string, dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.name === ".git" || e.name === "node_modules") return [];
    return e.isDirectory() ? walkTree(root, p) : [p];
  });
}

export function treeSource(repo: string): Source {
  const listed = git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const paths = (listed ? listed.split("\0").filter(Boolean) : walkTree(repo, "")).filter((p) =>
    existsSync(join(repo, p)),
  );
  return {
    paths,
    read: (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : undefined),
  };
}

export function parseCommitLog(output: string): Commit[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, time, ...s] = l.split("\t");
      if (hash === undefined) throw new Error(`Commit hash missing: ${l}`);
      return { hash, time: Number(time), subject: s.join("\t") };
    });
}

export async function readCommits(repo: string, args: string[]): Promise<Commit[]> {
  return parseCommitLog(await gitAsync(repo, ["log", "--format=%h%x09%ct%x09%s", ...args]));
}

export async function readGitMetadata(repo: string, workDir: string) {
  const [workLog, head, behind, trackingLog, log, fetched] = await Promise.all([
    gitAsync(repo, ["log", "-z", "--format=@%ct", "--name-only", "--", workDir]),
    gitAsync(repo, ["rev-parse", "--short", "HEAD"]),
    gitBytes(repo, ["rev-list", "--count", "HEAD..@{push}"]),
    readCommits(repo, ["-n", "60", "--", workDir]),
    readCommits(repo, ["-n", "60"]),
    fetchedAt(repo),
  ]);
  return {
    workLog,
    head: head.trim(),
    behind: behind ? Number(behind.toString().trim()) : undefined,
    trackingLog,
    log,
    fetched,
  };
}

// When the repository was last fetched: its FETCH_HEAD's time, which a worktree keeps in its own
// git folder rather than in <repo>/.git.
const fetchHeads = new Map<string, Promise<string>>();
export async function fetchedAt(repo: string) {
  let path = fetchHeads.get(repo);
  if (!path) {
    path = gitAsync(repo, ["rev-parse", "--git-path", "FETCH_HEAD"]).then((p) =>
      p.trim() ? resolve(repo, p.trim()) : "",
    );
    fetchHeads.set(repo, path);
  }
  const file = await path;
  if (!file) fetchHeads.delete(repo);
  return file && existsSync(file) ? statSync(file).mtimeMs : undefined;
}
