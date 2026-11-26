import elements from "../brand-elements.json";
import { policy } from "../site/src/data.ts";
import { THUMB_BOXES } from "./display.ts";
import { fileEtag, readRepoFile, resizeThumbnail } from "./serve-files.ts";
import { rewriteMissingPage, type PageDecorator, type Site } from "./serve-pages.ts";

const LOCAL = /^(127\.0\.0\.1|localhost|[\w.-]+\.localhost)$/;

// The catalog is the package's own pages, with the inline scripts Astrobook and the catalog shell
// write and no committed markup from a repository, so it gets brand-elements.json "csp" alone,
// which brand-elements and brand-markers render the catalog under; every other page policy() in
// site/src/data.ts, which only the site's own build under /_astro/ may run.
const catalogCsp = elements.csp;
export const csp = (origin: string) => `${policy(`${origin}/_astro/`)}; frame-ancestors 'self'`;

const IMMUTABLE = "public, max-age=31536000, immutable";

export type ParsedRequest = {
  url: URL;
  path: string;
  gzip: boolean;
  ifNoneMatch: string | null;
};

type RequestCheck = { request: ParsedRequest } | { response: Response };

export type PageMatch =
  | { kind: "strip-slash" }
  | { kind: "file"; at: string }
  | { kind: "doc"; name: string }
  | { kind: "dashboard" }
  | { kind: "missing" };

interface Responder {
  page(parsed: ParsedRequest, body: Buffer, name: string): Response;
  immutable(parsed: ParsedRequest, body: Buffer, name: string): Response;
  catalog(parsed: ParsedRequest, body: Buffer, name: string): Response;
  file(parsed: ParsedRequest, body: Buffer, name: string): Response;
}

// A page elsewhere, another port of this machine included, may link the hub, but a script,
// image or fetch from it would learn which repositories and files exist from whether each one
// loads.
export function isAllowedFetchSite(from: string | null, mode: string | null): boolean {
  return !(from && from !== "same-origin" && from !== "none" && mode !== "navigate");
}

export function parseRequest(req: Request): RequestCheck {
  const url = new URL(req.url);
  // Only a local name: a page elsewhere that points its own domain at 127.0.0.1 reads nothing.
  if (!LOCAL.test(url.hostname)) return { response: new Response("local only", { status: 403 }) };
  if (!isAllowedFetchSite(req.headers.get("sec-fetch-site"), req.headers.get("sec-fetch-mode")))
    return { response: new Response("not from another site", { status: 403 }) };
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return { response: new Response("malformed path", { status: 400 }) };
  }
  const gzip = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  return { request: { url, path, gzip, ifNoneMatch: req.headers.get("if-none-match") } };
}

export function responseHeaders(
  contentType: string,
  cacheControl: string,
  policyHeader: string,
): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": cacheControl,
    "content-security-policy": policyHeader,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    vary: "accept-encoding",
  };
}

export function isCompressible(body: Buffer, contentType: string): boolean {
  return body.length > 1024 && /^(text\/|application\/json|image\/svg)/.test(contentType);
}

export function createResponder(): Responder {
  // A built file is compressed once, on its first request that accepts gzip.
  const gzipped = new WeakMap<Buffer, Uint8Array<ArrayBuffer>>();

  function compressedResponse(
    body: Buffer,
    headers: Record<string, string>,
    acceptsGzip: boolean,
  ): Response {
    const zip = acceptsGzip && isCompressible(body, headers["content-type"]!);
    let bytes = zip ? gzipped.get(body) : new Uint8Array(body);
    if (!bytes) gzipped.set(body, (bytes = Bun.gzipSync(new Uint8Array(body))));
    return new Response(bytes, {
      headers: zip ? { ...headers, "content-encoding": "gzip" } : headers,
    });
  }

  return {
    page(parsed, body, name) {
      const headers = responseHeaders(Bun.file(name).type, "no-store", csp(parsed.url.origin));
      return compressedResponse(body, headers, parsed.gzip);
    },
    immutable(parsed, body, name) {
      const headers = responseHeaders(Bun.file(name).type, IMMUTABLE, csp(parsed.url.origin));
      return compressedResponse(body, headers, parsed.gzip);
    },
    catalog(parsed, body, name) {
      const cache = name.startsWith("_astro/") ? IMMUTABLE : "no-store";
      const headers = responseHeaders(Bun.file(name).type, cache, catalogCsp);
      return compressedResponse(body, headers, parsed.gzip);
    },
    // Only a built file is compressed: a committed file under /_file/ is read per request.
    file(parsed, body, name) {
      const headers = responseHeaders(Bun.file(name).type, "no-cache", csp(parsed.url.origin));
      return new Response(new Uint8Array(body), { headers });
    },
  };
}

// Hashed asset names never change, so an asset needs no check whether a repository moved, and
// the browser keeps it.
export function astroAssetRoute(
  parsed: ParsedRequest,
  site: Site | undefined,
  responder: Responder,
): Response | undefined {
  if (parsed.path.startsWith("/_astro/") && site?.files.has(parsed.path.slice(1)))
    return responder.immutable(parsed, site.files.get(parsed.path.slice(1))!, parsed.path);
  return undefined;
}

export async function serveRepoFile(
  parsed: ParsedRequest,
  body: Buffer,
  responder: Responder,
): Promise<Response> {
  const box = THUMB_BOXES.find(([w]) => w === Number(parsed.url.searchParams.get("w")));
  const etag = fileEtag(body, box);
  if (parsed.ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
  const small = box && (await resizeThumbnail(body, box));
  const response = responder.file(parsed, small || body, small ? "thumb.webp" : parsed.path);
  response.headers.set("etag", etag);
  return response;
}

export function createFileRoute(
  ensureSite: () => Promise<Site | undefined>,
  responder: Responder,
  readFile: (repo: string | undefined, path: string) => Promise<Buffer | undefined> = readRepoFile,
) {
  async function serve(parsed: ParsedRequest): Promise<Response> {
    const site = await ensureSite();
    const [repoKey, ...rest] = parsed.path.slice("/_file/".length).split("/");
    const repo = site?.repos.find((r) => r.key === repoKey)?.path;
    const body = await readFile(repo, rest.join("/"));
    if (!body) return new Response("not committed", { status: 404 });
    return serveRepoFile(parsed, body, responder);
  }

  return function handleFile(parsed: ParsedRequest): Promise<Response> | undefined {
    if (!parsed.path.startsWith("/_file/")) return undefined;
    return serve(parsed);
  };
}

export function createCatalogRoute(
  loadCatalog: () => Promise<Map<string, Buffer>>,
  responder: Responder,
) {
  let catalog: Promise<Map<string, Buffer>> | undefined;

  async function serve(parsed: ParsedRequest): Promise<Response> {
    // A failed build answers with its reason until the hub restarts, rather than building again
    // on every request.
    const built = await (catalog ??= loadCatalog()).catch((e: Error) => e);
    if (built instanceof Error)
      return new Response(
        `${built.message}: the catalog builds with astrobook and @hackersandwizards/scaffolding installed beside this package; install them and restart admin-serve`,
        { status: 503 },
      );
    const name = parsed.path.slice("/catalog/".length).replace(/\/$/, "");
    const at = [name, name ? `${name}/index.html` : "index.html"].find((n) => built.has(n));
    return at
      ? responder.catalog(parsed, built.get(at)!, at)
      : new Response("no such page", { status: 404 });
  }

  return function handleCatalog(parsed: ParsedRequest): Response | Promise<Response> | undefined {
    const { path, url } = parsed;
    if (path === "/catalog") return Response.redirect(`${url.origin}/catalog/${url.search}`, 302);
    if (!path.startsWith("/catalog/")) return undefined;
    return serve(parsed);
  };
}

export function matchSitePage(
  path: string,
  files: ReadonlyMap<string, Buffer>,
  docs: ReadonlyMap<string, unknown>,
): PageMatch {
  // A page's asset URLs are relative, so they only resolve from the page's own address.
  const bare = path.slice(1, -1);
  if (path.length > 1 && path.endsWith("/") && (files.has(`${bare}.html`) || docs.has(bare)))
    return { kind: "strip-slash" };
  const name = path.slice(1) || "index.html";
  // The 404 page answers only where no page does.
  const at = [name, `${name}.html`].find((n) => n !== "404.html" && files.has(n));
  if (at) return { kind: "file", at };
  // A doc's slug may end in .html itself, as for x.html.md.
  const doc = [name.replace(/\.html$/, ""), name].find((n) => docs.has(n));
  if (doc) return { kind: "doc", name: doc };
  // A repository's own address, with or without the slash, opens its dashboard.
  if (files.has(`${path.slice(1).replace(/\/$/, "")}/dashboard.html`)) return { kind: "dashboard" };
  return { kind: "missing" };
}

export function createPageRoute(
  loadSite: () => Promise<Site>,
  decorator: PageDecorator,
  responder: Responder,
) {
  function missingResponse(parsed: ParsedRequest, built: Site): Response {
    const html = rewriteMissingPage(
      built.files.get("404.html")!.toString("utf8"),
      parsed.url.pathname,
    );
    const response = responder.page(parsed, decorator.withNotice(Buffer.from(html)), "404.html");
    return new Response(response.body, { status: 404, headers: response.headers });
  }

  function respondForMatch(parsed: ParsedRequest, built: Site, match: PageMatch): Response {
    const { url } = parsed;
    if (match.kind === "strip-slash")
      return Response.redirect(url.origin + url.pathname.slice(0, -1) + url.search, 302);
    if (match.kind === "file") {
      const hit = built.files.get(match.at)!;
      const body = match.at.endsWith(".html")
        ? decorator.withNotice(decorator.stamp(hit, match.at, built.repos))
        : hit;
      return responder.page(parsed, body, match.at);
    }
    if (match.kind === "doc")
      return responder.page(parsed, decorator.withNotice(built.docPage(match.name)!), "doc.html");
    if (match.kind === "dashboard")
      return Response.redirect(
        `${url.origin}${url.pathname.replace(/\/$/, "")}/dashboard${url.search}`,
        302,
      );
    return missingResponse(parsed, built);
  }

  return async function handlePage(parsed: ParsedRequest): Promise<Response> {
    const built = await loadSite().catch((e: unknown) => e);
    if (built instanceof Error)
      return new Response(
        `The hub could not build its pages: ${built.message}. It tries again a minute later, or once a repository changes.`,
        { status: 503 },
      );
    const site = built as Site;
    return respondForMatch(parsed, site, matchSitePage(parsed.path, site.files, site.docs));
  };
}
