// Each build runs in a child process, since an Astro build leaves about 50 MB behind in the
// process that ran it, and file:// links are served under /_file/<repo>/, since a browser opens no
// file:// link from an http page.
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
import { fileHref, git, gitAsync, gitEnv, readRepo, type RepoData } from "./repo.ts";

export type ServeOptions = { root: string; rescanMs?: number };

// The pages show when each repository was last fetched, so a fetch that moves no ref counts too.
export async function stateOf(repo: string) {
  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  const fetched = existsSync(fetchHead) ? statSync(fetchHead).mtimeMs : 0;
  return (await gitAsync(repo, ["show-ref", "--head"])) + fetched;
}

const LOCAL = /^(127\.0\.0\.1|localhost|[\w.-]+\.localhost)$/;

// Item and doc bodies render committed raw HTML, and /_file/ serves every committed file from this
// origin, so only the site's own build under /_astro/ may run, with no <base> to repoint it, else
// that markup could read every repository through /_file/. Nor may it post a form or frame a page
// from elsewhere, which would put an outside login inside the hub; withElements in repo.ts defuses
// the meta refresh no policy stops, and a refresh inside a frame stays under frame-src. Reports lay
// themselves out in raw HTML, so styles and images stay free.
export const csp = (origin: string) =>
  `script-src ${origin}/_astro/; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'`;

export function createHub({ root, rescanMs = 300_000 }: ServeOptions) {
  let paths: Promise<string[]> | undefined;
  let scanned = 0;
  let scanning: Promise<string[]> | undefined;
  const read = new Map<string, { state: string; data: RepoData }>();
  let site: { key: string; files: Map<string, Buffer> } | undefined;
  let building: Promise<Map<string, Buffer>> | undefined;

  async function rebuild(key: string, repos: RepoData[]) {
    const out = mkdtempSync(join(tmpdir(), "admin-serve-"));
    const json = `${out}.json`;
    try {
      writeFileSync(json, JSON.stringify(siteData(repos)));
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

  async function pages() {
    // The first request waits for the search; a later one keeps the last result while the next
    // search runs.
    if (!paths || Date.now() - scanned > rescanMs) {
      scanned = Date.now();
      const next = (scanning = findRepos(root));
      if (paths)
        next.then(() => {
          // Only the latest search replaces the list, should an earlier one finish after it.
          if (scanning === next) paths = next;
        }, console.error);
      else (paths = next).catch(() => (paths = undefined));
    }
    const current = await paths;
    // A repository gone from the search leaves no entry for /_file/ to find under its key.
    for (const p of read.keys()) if (!current.includes(p)) read.delete(p);
    const states = await Promise.all(current.map(async (p) => [p, await stateOf(p)] as const));
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

  // Specimen pages link brand's stylesheets under node_modules, which no commit holds, so the
  // installed file answers, only from inside the repository, since a symlink there may point
  // anywhere on disk.
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
          "content-security-policy": csp(url.origin),
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
    // A page's asset URLs are relative, so they only resolve from the page's own address.
    if (path.length > 1 && path.endsWith("/") && files.has(`${path.slice(1, -1)}.html`))
      return Response.redirect(url.origin + url.pathname.slice(0, -1) + url.search, 302);
    const name = path.slice(1) || "index.html";
    const hit = files.get(name) ?? files.get(`${name}.html`);
    if (hit) return typed(hit, files.has(name) ? name : `${name}.html`);
    // A repository's own address, with or without the slash, opens its dashboard.
    if (files.has(`${path.slice(1).replace(/\/$/, "")}/dashboard.html`))
      return Response.redirect(
        `${url.origin}${url.pathname.replace(/\/$/, "")}/dashboard${url.search}`,
        302,
      );
    return new Response("no such page", { status: 404 });
  }

  return { fetch, pages };
}

if (import.meta.main) {
  const [json, out] = Bun.argv.slice(2);
  await buildSite(JSON.parse(readFileSync(json!, "utf8")), out!);
}
