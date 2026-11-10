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
import { basename, join, relative, resolve, sep } from "node:path";
import {
  buildCatalog,
  buildSite,
  filesUnder,
  firstWord,
  PKG,
  SHELL,
  shelled,
  shellPath,
  siteData,
} from "./build.ts";
import elements from "../brand-elements.json";
import { findRepos, uniqueKeys } from "./hub.ts";
import { NOTICE } from "../site/src/data.ts";
import {
  docSlug,
  encodeFile,
  encodePath,
  fetchedAt,
  fileHref,
  git,
  gitAsync,
  gitBytes,
  readRepo,
  THUMB_BOXES,
  type Doc,
  type RepoData,
  when,
} from "./repo.ts";

export type ServeOptions = { root: string; rescanMs?: number };

// The pages show when each repository was last fetched, so a fetch that moves no ref counts too.
export async function stateOf(repo: string) {
  const [refs, fetched] = await Promise.all([
    gitAsync(repo, ["show-ref", "--head"]),
    fetchedAt(repo),
  ]);
  return refs + (fetched ?? 0);
}

const LOCAL = /^(127\.0\.0\.1|localhost|[\w.-]+\.localhost)$/;

// Item and doc bodies render committed raw HTML, and /_file/ serves every committed file from this
// origin, so only the site's own build under /_astro/ may run, with no <base> to repoint it, else
// that markup could read every repository through /_file/. Nor may it post a form or frame a page
// from elsewhere, which would put an outside login inside the hub; withElements in repo.ts defuses
// the meta refresh no policy stops, and a refresh inside a frame stays under frame-src. Reports lay
// themselves out in raw HTML, so inline styles stay, but nothing loads from elsewhere: an image or
// a stylesheet's url() would report each view and could read the page's attributes out. Only a
// catalog's dev server on this machine is asked whether it runs (admin.js). The catalog is the
// package's own pages, with the inline scripts Astrobook and the catalog shell write and no
// committed markup from a repository, so it gets the rest without script-src or default-src:
// brand-elements.json "csp", which brand-elements and brand-markers render the catalog under.
const catalogCsp = elements.csp;
export const csp = (origin: string) =>
  [
    "default-src 'self'",
    `script-src ${origin}/_astro/`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "frame-ancestors 'self'",
    catalogCsp,
  ].join("; ");

const IMMUTABLE = "public, max-age=31536000, immutable";

// Runs this file as a child that builds into `out`, then reads what it wrote, keyed by path.
async function spawnBuild(what: string, args: string[], out: string) {
  const child = Bun.spawn([process.execPath, import.meta.path, ...args, out], { stderr: "pipe" });
  const err = await new Response(child.stderr).text();
  process.stderr.write(err);
  if (await child.exited) {
    // The thrown error's own line, as Bun prints it: "TypeError: ...", "error: ...".
    const line = err.match(/^(?:error|[A-Z]\w*): \S.*$/m)?.[0];
    throw new Error(`${what} failed: ${line ?? `exit ${child.exitCode}`}`);
  }
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

// Fits an image into `box`. An animated file, one that already fits, one the WebP would not shrink
// and one Bun cannot read answer as committed; only a file that is no image goes unlogged.
async function resized(body: Buffer, [width, height]: readonly [number, number]) {
  try {
    const image = new Bun.Image(body, { maxPixels: 64_000_000 });
    const size = await image.metadata();
    const animated = size.format === "gif" || body.includes("acTL") || body.includes("ANIM");
    if (animated || (size.width <= width && size.height <= height)) return undefined;
    const small = await image
      .resize(width, height, { fit: "inside" })
      .webp({ quality: 80 })
      .buffer();
    return small.length < body.length ? small : undefined;
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_IMAGE_UNKNOWN_FORMAT")
      console.error("admin-serve: thumbnail:", e);
    return undefined;
  }
}

// file:// links as the hub serves them: one to a doc with a page opens that page, any other the
// committed file under /_file/<repo>/.
export function linker(repos: RepoData[]) {
  const pageOf = new Map(
    repos.flatMap((r) =>
      [...r.reports, ...r.docs].map(
        (d) =>
          [
            fileHref(join(r.path, d.path)),
            `/${encodePath(`${r.key}/${docSlug(d.path)}`)}`,
          ] as const,
      ),
    ),
  );
  // Longest path first: a repository nested in another keeps its own prefix.
  const prefixes = [...repos]
    .sort((a, b) => b.path.length - a.path.length)
    .map((r) => [fileHref(r.path) + "/", `/_file/${encodeURIComponent(r.key)}/`] as const);
  const files = (html: string) => {
    for (const [from, to] of prefixes) html = html.replaceAll(from, to);
    return html;
  };
  const pages = (html: string) =>
    html.replace(/href="(file:\/\/[^"?#]*)([?#][^"]*)?"/g, (link, file: string, rest = "") => {
      const to = pageOf.get(file);
      return to ? `href="${to}${rest}"` : link;
    });
  return { files, pages };
}

type Site = {
  key: string;
  built: number;
  files: Map<string, Buffer>;
  repos: RepoData[];
  links: ReturnType<typeof linker>;
  // A doc page's path to its doc, each repository's shells by their paths, and the doc pages
  // filled so far.
  docs: Map<string, { repo: RepoData; doc: Doc }>;
  shells: Map<string, string>;
  filled: Map<string, Buffer>;
};

// A read or build that failed is tried again on a request once this passed, or sooner once a
// repository moves.
const RETRY_MS = 60_000;
const messageOf = (e: unknown) => (e as Error).message ?? String(e);

export function createHub({ root, rescanMs = 300_000 }: ServeOptions) {
  let paths: Promise<string[]> | undefined;
  let scanned = 0;
  let scanning: Promise<string[]> | undefined;
  const read = new Map<string, { state: string; data: RepoData }>();
  // A repository that failed to read at a state, and a build that failed for a key, say on every
  // page what went wrong.
  const unread = new Map<string, { state: string; at: number; message: string }>();
  let failed: { key: string; at: number; message: string } | undefined;
  const settled = (at: number) => Date.now() - at < RETRY_MS;
  let site: Site | undefined;
  let refreshing: Promise<Site> | undefined;
  let catalog: Promise<Map<string, Buffer>> | undefined;
  // A built file is compressed once, on its first request that accepts gzip.
  const gzipped = new WeakMap<Buffer, Uint8Array<ArrayBuffer>>();
  // The hub's user is the machine's git identity, by first name as item owners write it.
  const you = firstWord(git(root, "config", "user.name").trim()) || undefined;

  async function rebuild(key: string, repos: RepoData[]): Promise<Site> {
    const work = mkdtempSync(join(PKG, "site", ".build-"));
    const json = join(work, "data.json");
    const out = join(work, "out");
    try {
      const data = shelled(siteData(repos, you));
      writeFileSync(json, JSON.stringify(data));
      const files = await spawnBuild("build", [json], out);
      const links = linker(repos);
      const shellPaths = new Set(data.pages.filter((p) => p.article === SHELL).map((p) => p.path));
      const shells = new Map<string, string>();
      for (const [name, bytes] of files) {
        if (!name.endsWith(".html")) continue;
        const html = links.files(links.pages(bytes.toString("utf8")));
        const page = name.slice(0, -".html".length);
        if (shellPaths.has(page)) {
          shells.set(page, html);
          files.delete(name);
        } else files.set(name, Buffer.from(html));
      }
      // A doc's page is its repository's key and its slug, as siteData names it.
      const docs = new Map(
        repos.flatMap((repo) =>
          [...repo.reports, ...repo.docs].map(
            (doc) => [`${repo.key}/${docSlug(doc.path)}`, { repo, doc }] as const,
          ),
        ),
      );
      return { key, built: Date.now(), files, repos, links, shells, docs, filled: new Map() };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // A doc page, its doc filled into the shell for its depth, once per build.
  function docPage(name: string) {
    const hit = site?.docs.get(name);
    if (!site || !hit) return undefined;
    const done = site.filled.get(name);
    if (done) return done;
    const { repo, doc } = hit;
    const { links } = site;
    const shell = site.shells.get(shellPath(`${repo.key}/`, name.split("/").length))!;
    // As Astro escapes, so a filled page is the page a build renders.
    const escape = (text: string) => Bun.escapeHTML(text).replaceAll("&#x27;", "&#39;");
    const page = Buffer.from(
      shell
        // The file link ends in the mark, after the repository's part the shell already holds.
        .replaceAll(`/${SHELL.path}"`, () => `/${escape(encodeFile(doc.path))}"`)
        .replaceAll(SHELL.path, () => escape(doc.path))
        .replaceAll(SHELL.title, () => escape(doc.title))
        .replaceAll(
          `"${SHELL.name}.html"`,
          () => `"${encodeURIComponent(name.split("/").pop()!)}.html"`,
        )
        .replace(SHELL.html, () => links.files(links.pages(doc.html))),
    );
    site.filled.set(name, page);
    return page;
  }

  // What went wrong, for the notice on every page: the build that failed, and each repository
  // that could not be read at its current state. Set once a refresh ends.
  let notice = "";
  let noticed = new WeakMap<Buffer, Buffer>();
  function noticeHtml() {
    const lines = [...unread].map(([p, u]) => {
      const had = read.get(p);
      const name = had?.data.key ?? basename(p);
      return `${name} could not be read: ${u.message}. ${had ? "Its pages show its last read." : "It is left out."}`;
    });
    if (failed) lines.unshift(`The build stopped: ${failed.message}`);
    if (!lines.length) return "";
    const head = failed
      ? `The hub could not rebuild on ${when(failed.at)}.`
      : `The hub could not read ${lines.length === 1 ? "a repository" : `${lines.length} repositories`}.`;
    const shows =
      failed && site ? ` These pages show the repositories as of ${when(site.built)}.` : "";
    return `<p><b>${head}</b>${shows} It tries again a minute later, or once a repository changes; nothing to do unless this stays, and then the terminal running admin-serve shows the whole error.</p><ul class="hw-marker-list">${lines.map((l) => `<li>${Bun.escapeHTML(l)}</li>`).join("")}</ul>`;
  }
  const withNotice = (html: Buffer) => {
    if (!notice) return html;
    let page = noticed.get(html);
    if (!page)
      noticed.set(html, (page = Buffer.from(html.toString("utf8").replace(NOTICE, () => notice))));
    return page;
  };

  // Requests that arrive while one checks, reads or builds share its answer.
  const pages = () =>
    (refreshing ??= refresh().finally(() => {
      refreshing = undefined;
      const next = noticeHtml();
      if (next !== notice) [notice, noticed] = [next, new WeakMap()];
    }));

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
    for (const p of unread.keys()) if (!current.includes(p)) unread.delete(p);
    const states = await Promise.all(current.map(async (p) => [p, await stateOf(p)] as const));
    // The day is part of the state: a due date comes within a week of it with no commit.
    const key = [new Date(Date.now()).toDateString(), ...states.map(([p, s]) => `${p} ${s}`)].join(
      "\n",
    );
    const due = [...unread.values()].some((u) => !settled(u.at));
    if (site?.key === key && !due) return site;
    // A repository that fails to read keeps its last pages, or is left out.
    let fresh = false;
    const repos = (
      await Promise.all(
        states.map(async ([p, s]) => {
          const had = read.get(p);
          const u = unread.get(p);
          if (had?.state === s || (u?.state === s && settled(u.at))) return had ? [had.data] : [];
          try {
            const data = await readRepo(p);
            read.set(p, { state: s, data });
            unread.delete(p);
            fresh = true;
            return [data];
          } catch (e) {
            console.error(`admin-serve: ${p}:`, e);
            unread.set(p, { state: s, at: Date.now(), message: messageOf(e) });
            return had ? [had.data] : [];
          }
        }),
      )
    ).flat();
    if (site?.key === key && !fresh) return site;
    if (failed?.key === key && settled(failed.at) && !fresh) {
      if (site) return site;
      throw new Error(failed.message);
    }
    try {
      site = await rebuild(key, uniqueKeys(repos));
      failed = undefined;
    } catch (e) {
      console.error(e);
      failed = { key, at: Date.now(), message: messageOf(e) };
      if (!site) throw e;
    }
    return site;
  }

  // Specimen pages link brand's stylesheets under node_modules, which no commit holds, so the
  // installed file answers, only from inside the repository, since a symlink there may point
  // anywhere on disk.
  async function file(repoKey: string, path: string) {
    const repo = site?.repos.find((r) => r.key === repoKey)?.path;
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
    // A page elsewhere, another port of this machine included, may link the hub, but a script,
    // image or fetch from it would learn which repositories and files exist from whether each one
    // loads.
    const from = req.headers.get("sec-fetch-site");
    if (
      from &&
      from !== "same-origin" &&
      from !== "none" &&
      req.headers.get("sec-fetch-mode") !== "navigate"
    )
      return new Response("not from another site", { status: 403 });
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return new Response("malformed path", { status: 400 });
    }
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
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
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
      if (!body) return new Response("not committed", { status: 404 });
      const box = THUMB_BOXES.find(([w]) => w === Number(url.searchParams.get("w")));
      // Unchanged bytes keep their tag, so a repeat view skips the resize and the download.
      const etag = `"${Bun.hash(body).toString(36)}${box ? `-${box[0]}` : ""}"`;
      if (req.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { etag } });
      const small = box && (await resized(body, box));
      const response = typed(small || body, small ? "thumb.webp" : path, "no-cache", false);
      response.headers.set("etag", etag);
      return response;
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
    const built = await pages().catch((e: Error) => e);
    if (built instanceof Error)
      return new Response(
        `The hub could not build its pages: ${built.message}. It tries again a minute later, or once a repository changes.`,
        { status: 503 },
      );
    const { files, docs } = built;
    // A page's asset URLs are relative, so they only resolve from the page's own address.
    const bare = path.slice(1, -1);
    if (path.length > 1 && path.endsWith("/") && (files.has(`${bare}.html`) || docs.has(bare)))
      return Response.redirect(url.origin + url.pathname.slice(0, -1) + url.search, 302);
    const name = path.slice(1) || "index.html";
    const hit = files.get(name) ?? files.get(`${name}.html`);
    if (hit) {
      const at = files.has(name) ? name : `${name}.html`;
      return typed(at.endsWith(".html") ? withNotice(hit) : hit, at);
    }
    // A doc's slug may end in .html itself, as for x.html.md.
    const doc = docPage(name) ?? docPage(name.replace(/\.html$/, ""));
    if (doc) return typed(withNotice(doc), "doc.html");
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
