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
import { buildCatalog, buildSite, filesUnder, PKG, siteData } from "./build.ts";
import { findRepos } from "./hub.ts";
import { fileHref, gitAsync, gitBytes, readRepo, type RepoData } from "./repo.ts";

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

// The catalog is the package's own pages, with the inline scripts Astrobook and the catalog shell
// write and no committed markup from a repository.
const catalogCsp = "object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'";

const IMMUTABLE = "public, max-age=31536000, immutable";

// Runs this file as a child that builds into `out`, then reads what it wrote, keyed by path.
async function spawnBuild(what: string, args: string[], out: string) {
  const child = Bun.spawn([process.execPath, import.meta.path, ...args, out], {
    stderr: "inherit",
  });
  if (await child.exited) throw new Error(`admin-serve: ${what} exited ${child.exitCode}`);
  return new Map(filesUnder(out).map((f) => [relative(out, f), readFileSync(f)]));
}

// The engine's catalog at /catalog/, built once per hub from the package and kept: it changes only
// with the package.
async function catalogFiles() {
  const work = mkdtempSync(join(PKG, "site", ".build-"));
  try {
    return await spawnBuild("catalog build", ["--catalog"], join(work, "out"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function createHub({ root, rescanMs = 300_000 }: ServeOptions) {
  let paths: Promise<string[]> | undefined;
  let scanned = 0;
  let scanning: Promise<string[]> | undefined;
  const read = new Map<string, { state: string; data: RepoData }>();
  let site: { key: string; files: Map<string, Buffer> } | undefined;
  let refreshing: Promise<Map<string, Buffer>> | undefined;
  let catalog: Promise<Map<string, Buffer>> | undefined;
  // A built file is compressed once, on its first request that accepts gzip.
  const gzipped = new WeakMap<Buffer, Uint8Array<ArrayBuffer>>();

  async function rebuild(key: string, repos: RepoData[]) {
    const out = mkdtempSync(join(tmpdir(), "admin-serve-"));
    const json = `${out}.json`;
    try {
      writeFileSync(json, JSON.stringify(siteData(repos)));
      const files = await spawnBuild("build", [json], out);
      // Longest path first: a repository nested in another keeps its own prefix.
      const links = [...repos]
        .sort((a, b) => b.path.length - a.path.length)
        .map((r) => [fileHref(r.path) + "/", `/_file/${encodeURIComponent(r.key)}/`] as const);
      for (const [name, bytes] of files) {
        if (!name.endsWith(".html")) continue;
        let html = bytes.toString("utf8");
        for (const [from, to] of links) html = html.replaceAll(from, to);
        files.set(name, Buffer.from(html));
      }
      site = { key, files };
      return files;
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(json, { force: true });
    }
  }

  // Requests that arrive while one checks, reads or builds share its answer.
  const pages = () => (refreshing ??= refresh().finally(() => (refreshing = undefined)));

  async function refresh() {
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
    // A repository that fails to read keeps its last pages, or is left out, and is read again on
    // the next request.
    let failed = false;
    const repos = (
      await Promise.all(
        states.map(async ([p, s]) => {
          const had = read.get(p);
          if (had?.state === s) return [had.data];
          try {
            const data = await readRepo(p);
            read.set(p, { state: s, data });
            return [data];
          } catch (e) {
            console.error(`admin-serve: ${p}:`, e);
            failed = true;
            return had ? [had.data] : [];
          }
        }),
      )
    ).flat();
    // A failed build keeps the last pages on show and is tried again on the next request.
    return rebuild(failed ? "" : key, repos).catch((e) => {
      if (!site) throw e;
      console.error(e);
      return site.files;
    });
  }

  // Specimen pages link brand's stylesheets under node_modules, which no commit holds, so the
  // installed file answers, only from inside the repository, since a symlink there may point
  // anywhere on disk.
  async function file(repoKey: string, path: string) {
    const repo = [...read.values()].find((r) => r.data.key === repoKey)?.data.path;
    if (!repo || path.split("/").includes("..")) return undefined;
    if (path.startsWith("node_modules/")) {
      const installed = join(repo, path);
      if (!existsSync(installed) || !statSync(installed).isFile()) return undefined;
      return realpathSync(installed).startsWith(realpathSync(repo) + sep)
        ? readFileSync(installed)
        : undefined;
    }
    const blob = await gitBytes(repo, ["cat-file", "blob", `HEAD:${path}`]);
    if (!blob) return undefined;
    const oid = blob
      .subarray(0, 200)
      .toString()
      .match(/^version https:\/\/git-lfs\S+\noid sha256:([0-9a-f]{64})/)?.[1];
    if (!oid) return blob;
    const common = resolve(repo, (await gitAsync(repo, ["rev-parse", "--git-common-dir"])).trim());
    const object = join(common, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    return existsSync(object) ? readFileSync(object) : undefined;
  }

  async function fetch(req: Request) {
    const url = new URL(req.url);
    // Only a local name: a page elsewhere that points its own domain at 127.0.0.1 reads nothing.
    if (!LOCAL.test(url.hostname)) return new Response("local only", { status: 403 });
    const path = decodeURIComponent(url.pathname);
    const catalogPage = path === "/catalog" || path.startsWith("/catalog/");
    const gzip = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
    // Only a built file is compressed: a committed file under /_file/ is read per request.
    const typed = (body: Buffer, name: string, cache = "no-store", built = true) => {
      const type = Bun.file(name).type;
      const zip =
        built && gzip && body.length > 1024 && /^(text\/|application\/json|image\/svg)/.test(type);
      let bytes = zip ? gzipped.get(body) : new Uint8Array(body);
      if (!bytes) gzipped.set(body, (bytes = Bun.gzipSync(new Uint8Array(body))));
      return new Response(bytes, {
        headers: {
          "content-type": type,
          "cache-control": cache,
          "content-security-policy": catalogPage ? catalogCsp : csp(url.origin),
          vary: "accept-encoding",
          ...(zip && { "content-encoding": "gzip" }),
        },
      });
    };
    // Hashed asset names never change, so an asset needs no check whether a repository moved, and
    // the browser keeps it.
    if (path.startsWith("/_astro/") && site?.files.has(path.slice(1)))
      return typed(site.files.get(path.slice(1))!, path, IMMUTABLE);
    if (path.startsWith("/_file/")) {
      if (!site) await pages().catch(() => undefined);
      const [repoKey, ...rest] = path.slice("/_file/".length).split("/");
      const body = await file(repoKey!, rest.join("/"));
      return body
        ? typed(body, path, "no-store", false)
        : new Response("not committed", { status: 404 });
    }
    if (path === "/catalog") return Response.redirect(`${url.origin}/catalog/${url.search}`, 302);
    if (catalogPage) {
      // A failed build answers with its reason until the hub restarts, rather than building again
      // on every request.
      const built = await (catalog ??= catalogFiles()).catch((e: Error) => e);
      if (built instanceof Error)
        return new Response(
          `${built.message}: the catalog builds with astrobook and @hackersandwizards/scaffolding installed beside this package; install them and restart admin-serve`,
          { status: 503 },
        );
      const name = path.slice("/catalog/".length).replace(/\/$/, "");
      const at = [name, name ? `${name}/index.html` : "index.html"].find((n) => built.has(n));
      return at
        ? typed(built.get(at)!, at, at.startsWith("_astro/") ? IMMUTABLE : "no-store")
        : new Response("no such page", { status: 404 });
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
  if (json === "--catalog") await buildCatalog(out!);
  else await buildSite(JSON.parse(readFileSync(json!, "utf8")), out!);
}
