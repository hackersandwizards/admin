// Serves the hub over HTTP instead of writing it to disk. Every page request checks each
// repository's HEAD, upstream and last fetch; when one moved, that repository is read again at HEAD and the
// pages are rebuilt into memory, each build in a child process, since an Astro build leaves
// about 50 MB behind in the process that ran it. Paths that pages link as file:// are served from HEAD under
// /_file/<repo>/, since a browser opens no file:// link from an http page.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { buildSite, filesUnder, siteData } from "./build.ts";
import { findRepos } from "./hub.ts";
import { fileHref, git, gitEnv, readRepo, type RepoData } from "./repo.ts";

export type ServeOptions = { root: string; rescanMs?: number };

// What decides whether a repository's pages are current: every ref, HEAD and upstream included,
// and the last fetch.
export function stateOf(repo: string) {
  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  const fetched = existsSync(fetchHead) ? statSync(fetchHead).mtimeMs : 0;
  return git(repo, "show-ref", "--head") + fetched;
}

const LOCAL = /^(127\.0\.0\.1|localhost|[\w.-]+\.localhost)$/;

// Item and doc bodies render their raw HTML, so markup committed to any repository the hub reads
// lands on its pages. Only the site's own script files run: no inline script or event handler, no
// foreign script, and no <base> to repoint them, else that markup could read every repository
// through /_file/. Styles and images stay free, since reports lay themselves out in raw HTML.
export const CSP = "script-src 'self'; object-src 'none'; base-uri 'none'";

export function createHub({ root, rescanMs = 300_000 }: ServeOptions) {
  let paths: string[] = [];
  let scanned = 0;
  const read = new Map<string, { state: string; data: RepoData }>();
  let site: { key: string; files: Map<string, Buffer> } | undefined;
  let building: Promise<Map<string, Buffer>> | undefined;

  const scan = () => {
    scanned = Date.now();
    paths = findRepos(root);
  };

  async function rebuild(key: string, repos: RepoData[]) {
    const out = mkdtempSync(join(tmpdir(), "admin-serve-"));
    const json = `${out}.json`;
    try {
      writeFileSync(json, JSON.stringify(siteData(repos, true)));
      const child = Bun.spawn([process.execPath, import.meta.path, json, out], {
        stderr: "inherit",
      });
      if (await child.exited) throw new Error(`admin-serve: build exited ${child.exitCode}`);
      const files = new Map<string, Buffer>();
      // Longest path first: a repository nested in another keeps its own prefix.
      const links = [...repos]
        .sort((a, b) => b.path.length - a.path.length)
        .map((r) => [fileHref(r.path) + "/", `/_file/${encodeURIComponent(r.key)}/`] as const);
      for (const f of filesUnder(out)) {
        let bytes = readFileSync(f);
        if (f.endsWith(".html")) {
          let html = bytes.toString("utf8");
          for (const [from, to] of links) html = html.replaceAll(from, to);
          bytes = Buffer.from(html);
        }
        files.set(relative(out, f), bytes);
      }
      site = { key, files };
      return files;
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(json, { force: true });
    }
  }

  // The current pages, rebuilt only when a repository moved. Concurrent requests share one build.
  async function pages() {
    // The first request waits for the search; a later one finds new repositories on the next.
    if (!scanned) scan();
    else if (Date.now() - scanned > rescanMs) setTimeout(scan, 0);
    const states = paths.map((p) => [p, stateOf(p)] as const);
    const key = states.map(([p, s]) => `${p} ${s}`).join("\n");
    if (site?.key === key) return site.files;
    if (building) return building;
    // A repository that fails to read keeps its last pages, or is left out, and is read again on
    // the next request.
    let failed = false;
    const repos = states.flatMap(([p, s]) => {
      const had = read.get(p);
      if (had?.state === s) return [had.data];
      try {
        const data = readRepo(p);
        read.set(p, { state: s, data });
        return [data];
      } catch (e) {
        console.error(`admin-serve: ${p}:`, e);
        failed = true;
        return had ? [had.data] : [];
      }
    });
    // A failed build keeps the last pages on show and is tried again on the next request.
    building = rebuild(failed ? "" : key, repos)
      .catch((e) => {
        if (!site) throw e;
        console.error(e);
        return site.files;
      })
      .finally(() => (building = undefined));
    return building;
  }

  // A committed file of a repository the hub shows, read at HEAD. A Git LFS pointer resolves to
  // the object in the repository's local LFS store, never fetched. Under node_modules, which no
  // commit holds, the installed file answers: specimen pages link the brand's stylesheets there,
  // and only from inside the repository, since a symlink there may point anywhere on disk.
  function file(repoKey: string, path: string) {
    const repo = [...read.values()].find((r) => r.data.key === repoKey)?.data.path;
    if (!repo || path.split("/").includes("..")) return undefined;
    if (path.startsWith("node_modules/")) {
      const installed = join(repo, path);
      if (!existsSync(installed) || !statSync(installed).isFile()) return undefined;
      return realpathSync(installed).startsWith(realpathSync(repo) + sep)
        ? readFileSync(installed)
        : undefined;
    }
    const r = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", `HEAD:${path}`], {
      stderr: "ignore",
      env: gitEnv,
    });
    if (r.exitCode) return undefined;
    const oid = r.stdout
      .subarray(0, 200)
      .toString()
      .match(/^version https:\/\/git-lfs\S+\noid sha256:([0-9a-f]{64})/)?.[1];
    if (!oid) return r.stdout;
    const common = resolve(repo, git(repo, "rev-parse", "--git-common-dir").trim());
    const object = join(common, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    return existsSync(object) ? readFileSync(object) : undefined;
  }

  async function fetch(req: Request) {
    const url = new URL(req.url);
    // Only a local name: a page elsewhere that points its own domain at 127.0.0.1 reads nothing.
    if (!LOCAL.test(url.hostname)) return new Response("local only", { status: 403 });
    const path = decodeURIComponent(url.pathname);
    const typed = (body: Buffer, name: string) =>
      new Response(new Uint8Array(body), {
        headers: {
          "content-type": Bun.file(name).type,
          "cache-control": "no-store",
          "content-security-policy": CSP,
        },
      });
    // Hashed asset names never change, so an asset needs no check whether a repository moved.
    if (path.startsWith("/_astro/") && site?.files.has(path.slice(1)))
      return typed(site.files.get(path.slice(1))!, path);
    if (path.startsWith("/_file/")) {
      if (!site) await pages().catch(() => undefined);
      const [repoKey, ...rest] = path.slice("/_file/".length).split("/");
      const body = file(repoKey!, rest.join("/"));
      return body ? typed(body, path) : new Response("not committed", { status: 404 });
    }
    const files = await pages();
    const name = path.slice(1) || "index.html";
    const hit = files.get(name) ?? files.get(`${name.replace(/\/$/, "")}.html`);
    return hit
      ? typed(hit, files.has(name) ? name : `${name}.html`)
      : new Response("no such page", { status: 404 });
  }

  return { fetch, pages };
}

// The child: builds the pages of a site data file into a folder.
if (import.meta.main) {
  const [json, out] = Bun.argv.slice(2);
  await buildSite(JSON.parse(readFileSync(json!, "utf8")), out!);
}
