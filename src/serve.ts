// Each build runs in a child process, since an Astro build leaves about 50 MB behind in the
// process that ran it, and file:// links are served under /_file/<repo>/, since a browser opens no
// file:// link from an http page.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildCatalog, buildSite, filesUnder, PKG, shelled, writeSiteData } from "./build.ts";
import { git } from "./git.ts";
import { uniqueKeys } from "./hub.ts";
import type { RepoData } from "./repo.ts";
import {
  astroAssetRoute,
  createCatalogRoute,
  createFileRoute,
  createPageRoute,
  createResponder,
  parseRequest,
} from "./serve-http.ts";
import {
  createPageDecorator,
  extractShells,
  formatNotice,
  indexDocs,
  linker,
  type BuildNotice,
  type Site,
} from "./serve-pages.ts";
import {
  createRepoCache,
  createRepoScanner,
  errorMessageOf,
  RETRY_MS,
  type RepoCache,
} from "./serve-repos.ts";
import { firstWord, siteData } from "./site-data.ts";

export type ServeOptions = { root: string; rescanMs?: number };

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

export type BuildFailure = {
  key: string;
  at: number;
  message: string;
  isBuildError: boolean;
};

export type SiteBuildAction = "reuse" | "rethrow" | "build";

export function decideSiteBuild(
  current: { siteKey?: string; failed?: BuildFailure },
  target: { key: string; fresh: boolean },
  now: number,
): SiteBuildAction {
  if (current.siteKey === target.key && !target.fresh) return "reuse";
  if (current.failed?.key === target.key && now - current.failed.at < RETRY_MS && !target.fresh)
    return current.siteKey !== undefined ? "reuse" : "rethrow";
  return "build";
}

export async function loadSiteForFile(
  current: () => Site | undefined,
  load: () => Promise<Site>,
): Promise<Site | undefined> {
  const existing = current();
  if (existing) return existing;
  try {
    return await load();
  } catch (error) {
    if (error instanceof BuildError) return undefined;
    throw error;
  }
}

// Runs this file as a child that builds into `out`, then reads what it wrote, keyed by path.
async function spawnBuild(what: string, args: string[], out: string) {
  // In this process's time zone, which stamp() writes its times in.
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const child = Bun.spawn([process.execPath, import.meta.path, ...args, out], {
    stderr: "pipe",
    env: { ...process.env, TZ },
  });
  const err = await new Response(child.stderr).text();
  process.stderr.write(err);
  if (await child.exited) {
    // The thrown error's own line, as Bun prints it: "TypeError: ...", "error: ...".
    const line = err.match(/^(?:error|[A-Z]\w*): \S.*$/m)?.[0];
    throw new BuildError(`${what} failed: ${line ?? `exit ${child.exitCode}`}`);
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

async function rebuildSite(key: string, repos: RepoData[], you: string | undefined): Promise<Site> {
  const work = mkdtempSync(join(PKG, "site", ".build-"));
  const json = join(work, "data.json");
  const out = join(work, "out");
  try {
    const data = shelled(siteData(repos, you));
    writeSiteData(json, data);
    const files = await spawnBuild("build", [json], out);
    const links = linker(repos);
    const shells = extractShells(files, data.pages, links);
    const docs = indexDocs(repos);
    return { key, built: Date.now(), files, repos, links, shells, docs, filled: new Map() };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function createSiteStore(
  listRepos: () => Promise<string[]>,
  repoCache: RepoCache,
  build: (key: string, repos: RepoData[]) => Promise<Site>,
) {
  let site: Site | undefined;
  // A repository that failed to read at a state, and a build that failed for a key, say on every
  // page what went wrong.
  let failed: BuildFailure | undefined;

  async function refresh(): Promise<Site> {
    const { states, key, due } = await repoCache.probe(await listRepos());
    if (site?.key === key && !due) return site;
    const { repos, fresh } = await repoCache.load(states);
    const action = decideSiteBuild({ siteKey: site?.key, failed }, { key, fresh }, Date.now());
    if (action === "reuse") return site!;
    if (action === "rethrow") {
      throw failed!.isBuildError ? new BuildError(failed!.message) : new Error(failed!.message);
    }
    try {
      site = await build(key, uniqueKeys(repos));
      failed = undefined;
    } catch (e) {
      console.error(e);
      failed = {
        key,
        at: Date.now(),
        message: errorMessageOf(e),
        isBuildError: e instanceof BuildError,
      };
      if (!site) throw e;
    }
    return site;
  }

  function buildFailure(): BuildNotice | undefined {
    return failed ? { at: failed.at, message: failed.message, builtAt: site?.built } : undefined;
  }

  return { current: () => site, buildFailure, refresh };
}

export function createHub({ root, rescanMs = 300_000 }: ServeOptions) {
  const listRepos = createRepoScanner(root, rescanMs);
  const repoCache = createRepoCache();
  const decorator = createPageDecorator(repoCache.fetchedTime);
  // The hub's user is the machine's git identity, by first name as item owners write it.
  const you = firstWord(git(root, "config", "user.name").trim()) || undefined;
  const siteStore = createSiteStore(listRepos, repoCache, (key, repos) =>
    rebuildSite(key, repos, you),
  );
  let refreshing: Promise<Site> | undefined;
  // Requests that arrive while one checks, reads or builds share its answer.
  const pages = () =>
    (refreshing ??= siteStore.refresh().finally(() => {
      refreshing = undefined;
      decorator.setNotice(formatNotice(repoCache.unreadNotices(), siteStore.buildFailure()));
    }));
  const ensureSite = () => loadSiteForFile(siteStore.current, pages);
  const responder = createResponder();
  const fileRoute = createFileRoute(ensureSite, responder);
  const catalogRoute = createCatalogRoute(catalogFiles, responder);
  const pageRoute = createPageRoute(pages, decorator, responder);

  async function fetch(req: Request) {
    const checked = parseRequest(req);
    if ("response" in checked) return checked.response;
    const { request } = checked;
    return (
      astroAssetRoute(request, siteStore.current(), responder) ??
      (await fileRoute(request)) ??
      (await catalogRoute(request)) ??
      (await pageRoute(request))
    );
  }

  return { fetch, pages };
}

if (import.meta.main) {
  const [json, out] = Bun.argv.slice(2);
  if (json === "--catalog") await buildCatalog(out!);
  else await buildSite({ file: resolve(json!) }, out!);
}
