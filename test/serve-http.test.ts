import { assert, describe, expect, test, vi } from "vitest";
import elements from "../brand-elements.json";
import { SHELL, shellPath } from "../src/build.ts";
import type { RepoData } from "../src/repo.ts";
import {
  astroAssetRoute,
  catalogCsp,
  createCatalogRoute,
  createFileRoute,
  createPageRoute,
  createResponder,
  csp,
  IMMUTABLE,
  isAllowedFetchSite,
  isCompressible,
  matchSitePage,
  parseRequest,
  responseHeaders,
  serveRepoFile,
  type PageMatch,
  type ParsedRequest,
} from "../src/serve-http.ts";
import { createPageDecorator, indexDocs, linker, type Site } from "../src/serve-pages.ts";

const parsedFor = (url: string, gzip = false, ifNoneMatch: string | null = null): ParsedRequest => {
  const checked = parseRequest(
    new Request(url, {
      headers: {
        ...(gzip ? { "accept-encoding": "gzip" } : {}),
        ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}),
      },
    }),
  );
  assert("request" in checked, `expected valid request for ${url}`);
  return checked.request;
};

const makeSite = (): Site => {
  const repo: RepoData = {
    key: "demo",
    path: "/r/demo",
    label: "Demo",
    head: "abc123",
    items: [],
    reports: [],
    reviews: [],
    docs: [{ path: "README.md", title: "Readme", html: "<p>Doc body</p>" }],
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
  };
  return {
    key: "k1",
    built: 1_000,
    files: new Map<string, Buffer>([
      ["index.html", Buffer.from("<p>Home <!--admin-notice--></p>")],
      ["demo/dashboard.html", Buffer.from("<p>Dash</p>")],
      ["_astro/app.css", Buffer.from("body{}")],
      ["404.html", Buffer.from('<a href="index.html">Hub</a> admin-missing-path')],
    ]),
    repos: [repo],
    links: linker([repo]),
    docs: indexDocs([repo]),
    shells: new Map([[shellPath("demo/", 3), `<main>${SHELL.html}</main>`]]),
    filled: new Map(),
  };
};

describe("isAllowedFetchSite", () => {
  test.each([
    { label: "no header", from: null, mode: null, expected: true },
    { label: "same-origin subresource", from: "same-origin", mode: "no-cors", expected: true },
    { label: "none navigation", from: "none", mode: "navigate", expected: true },
    { label: "cross-site navigation", from: "cross-site", mode: "navigate", expected: true },
    { label: "same-site navigation", from: "same-site", mode: "navigate", expected: true },
    { label: "cross-site script", from: "cross-site", mode: "no-cors", expected: false },
    { label: "same-site cors fetch", from: "same-site", mode: "cors", expected: false },
  ])("$label -> $expected", ({ from, mode, expected }) => {
    expect(isAllowedFetchSite(from, mode)).toBe(expected);
  });
});

describe("parseRequest", () => {
  test.each<{
    label: string;
    url: string;
    headers: Record<string, string>;
    status: number;
    text: string;
  }>([
    {
      label: "non-local host",
      url: "http://evil.example/",
      headers: {},
      status: 403,
      text: "local only",
    },
    {
      label: "cross-site subresource",
      url: "http://admin.localhost/a",
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
      status: 403,
      text: "not from another site",
    },
    {
      label: "malformed percent escape",
      url: "http://admin.localhost/%E0%A4%A",
      headers: {},
      status: 400,
      text: "malformed path",
    },
  ])("rejects $label", async ({ url, headers, status, text }) => {
    const checked = parseRequest(new Request(url, { headers }));
    assert("response" in checked, "expected rejection response");
    expect(checked.response.status).toBe(status);
    expect(await checked.response.text()).toBe(text);
  });

  test("decodes path and reads gzip and if-none-match for valid local requests", () => {
    const checked = parseRequest(
      new Request("http://127.0.0.1:4329/demo/c%23-notes", {
        headers: { "accept-encoding": "br, gzip", "if-none-match": '"tag"' },
      }),
    );
    assert("request" in checked, "expected parsed request");
    expect(checked.request.path).toBe("/demo/c#-notes");
    expect(checked.request.gzip).toBe(true);
    expect(checked.request.ifNoneMatch).toBe('"tag"');
  });
});

describe("responseHeaders and isCompressible", () => {
  test("sets security and cache headers", () => {
    expect(responseHeaders("text/html", "no-store", catalogCsp)).toEqual({
      "content-type": "text/html",
      "cache-control": "no-store",
      "content-security-policy": elements.csp,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      vary: "accept-encoding",
    });
  });

  test.each([
    { label: "large text/html", body: Buffer.alloc(1025, 97), type: "text/html", expected: true },
    {
      label: "exact 1024-byte text/html",
      body: Buffer.alloc(1024, 97),
      type: "text/html",
      expected: false,
    },
    { label: "large json", body: Buffer.alloc(2000, 97), type: "application/json", expected: true },
    { label: "large svg", body: Buffer.alloc(2000, 97), type: "image/svg+xml", expected: true },
    { label: "large png", body: Buffer.alloc(2000, 97), type: "image/png", expected: false },
  ])("$label -> $expected", ({ body, type, expected }) => {
    expect(isCompressible(body, type)).toBe(expected);
  });
});

describe("createResponder", () => {
  test("compresses built pages when accepted and never compresses /_file/ responses", async () => {
    const responder = createResponder();
    const big = Buffer.from("<p>hello</p>".repeat(200));
    const req = parsedFor("http://admin.localhost/", true);

    const pageRes = responder.page(req, big, "index.html");
    expect(pageRes.headers.get("content-encoding")).toBe("gzip");
    expect(pageRes.headers.get("cache-control")).toBe("no-store");
    expect(pageRes.headers.get("content-security-policy")).toBe(csp("http://admin.localhost"));

    const fileRes = responder.file(req, big, "note.txt");
    expect(fileRes.headers.get("content-encoding")).toBeNull();
    expect(fileRes.headers.get("cache-control")).toBe("no-cache");
  });

  test("sets catalog CSP and immutable cache for catalog _astro assets", () => {
    const responder = createResponder();
    const req = parsedFor("http://admin.localhost/catalog/_astro/a.css");
    const asset = responder.catalog(req, Buffer.from("body{}"), "_astro/a.css");
    const home = responder.catalog(req, Buffer.from("<p>hi</p>"), "index.html");
    expect(asset.headers.get("content-security-policy")).toBe(catalogCsp);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(home.headers.get("cache-control")).toBe("no-store");
  });
});

describe("astroAssetRoute", () => {
  test("serves cached /_astro/ files immutably and returns undefined for misses", () => {
    const responder = createResponder();
    const site = makeSite();
    const hit = astroAssetRoute(
      parsedFor("http://admin.localhost/_astro/app.css"),
      site,
      responder,
    );
    assert(hit, "expected asset hit");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(
      astroAssetRoute(parsedFor("http://admin.localhost/_astro/missing.css"), site, responder),
    ).toBeUndefined();
    expect(
      astroAssetRoute(parsedFor("http://admin.localhost/_astro/app.css"), undefined, responder),
    ).toBeUndefined();
  });
});

describe("serveRepoFile and createFileRoute", () => {
  test("returns 304 on matching etag and 200 with etag otherwise", async () => {
    const responder = createResponder();
    const body = Buffer.from("sample bytes");
    const first = await serveRepoFile(
      parsedFor("http://admin.localhost/_file/demo/note.txt"),
      body,
      responder,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"1fbmfdrc7cn9z"');

    const repeat = await serveRepoFile(
      parsedFor("http://admin.localhost/_file/demo/note.txt", false, '"1fbmfdrc7cn9z"'),
      body,
      responder,
    );
    expect(repeat.status).toBe(304);
    expect(repeat.headers.get("etag")).toBe('"1fbmfdrc7cn9z"');
  });

  test("ignores non-/_file/ paths, returns 404 when missing, and serves resolved files", async () => {
    const responder = createResponder();
    const site = makeSite();
    const known = new Map<string, Buffer>([["/r/demo:a.txt", Buffer.from("ok")]]);
    const route = createFileRoute(
      async () => site,
      responder,
      async (repo, p) => known.get(`${repo}:${p}`),
    );
    expect(await route(parsedFor("http://admin.localhost/demo/dashboard"))).toBeUndefined();
    const miss = await route(parsedFor("http://admin.localhost/_file/demo/absent.txt"));
    assert(miss, "missing response");
    expect(miss.status).toBe(404);
    const hit = await route(parsedFor("http://admin.localhost/_file/demo/a.txt"));
    assert(hit, "found response");
    expect(await hit.text()).toBe("ok");
  });
});

describe("createCatalogRoute", () => {
  test("redirects bare /catalog with query, serves nested pages, and returns 404 for unknown paths", async () => {
    const responder = createResponder();
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("<p>Catalog</p>")],
      ["stories/a/index.html", Buffer.from("<p>Story</p>")],
    ]);
    const route = createCatalogRoute(async () => files, responder);

    expect(await route(parsedFor("http://admin.localhost/"))).toBeUndefined();
    const redirect = await route(parsedFor("http://admin.localhost/catalog?q=1"));
    assert(redirect, "redirect response");
    expect([redirect.status, redirect.headers.get("location")]).toEqual([
      302,
      "http://admin.localhost/catalog/?q=1",
    ]);
    const story = await route(parsedFor("http://admin.localhost/catalog/stories/a"));
    assert(story, "story response");
    expect(await story.text()).toBe("<p>Story</p>");
    const miss = await route(parsedFor("http://admin.localhost/catalog/missing"));
    assert(miss, "miss response");
    expect(miss.status).toBe(404);
  });

  test("caches a failed catalog build as 503", async () => {
    const load = vi.fn(async () => {
      throw new Error("catalog build failed: boom");
    });
    const route = createCatalogRoute(load, createResponder());
    const first = await route(parsedFor("http://admin.localhost/catalog/"));
    const second = await route(parsedFor("http://admin.localhost/catalog/"));
    assert(first, "first 503");
    assert(second, "second 503");
    expect(first.status).toBe(503);
    expect(await first.text()).toContain("catalog build failed: boom");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("matchSitePage", () => {
  const files = new Map<string, Buffer>([
    ["index.html", Buffer.alloc(0)],
    ["404.html", Buffer.alloc(0)],
    ["demo/dashboard.html", Buffer.alloc(0)],
    ["demo/decisions.html", Buffer.alloc(0)],
  ]);
  const docs = new Map<string, unknown>([
    ["demo/doc/README", {}],
    ["demo/doc/docs/page.html", {}],
  ]);

  test.each<[string, string, PageMatch]>([
    ["root index", "/", { kind: "file", at: "index.html" }],
    ["explicit index.html", "/index.html", { kind: "file", at: "index.html" }],
    ["extensionless page", "/demo/decisions", { kind: "file", at: "demo/decisions.html" }],
    ["trailing slash on page", "/demo/decisions/", { kind: "strip-slash" }],
    ["trailing slash on doc", "/demo/doc/README/", { kind: "strip-slash" }],
    ["doc page without extension", "/demo/doc/README", { kind: "doc", name: "demo/doc/README" }],
    [
      "doc page with .html extension",
      "/demo/doc/README.html",
      { kind: "doc", name: "demo/doc/README" },
    ],
    [
      "doc whose slug ends in .html",
      "/demo/doc/docs/page.html",
      { kind: "doc", name: "demo/doc/docs/page.html" },
    ],
    [
      "doc whose slug ends in .html with .html suffix",
      "/demo/doc/docs/page.html.html",
      { kind: "doc", name: "demo/doc/docs/page.html" },
    ],
    ["bare repository key", "/demo", { kind: "dashboard" }],
    ["repository key with slash", "/demo/", { kind: "dashboard" }],
    ["direct /404 path", "/404", { kind: "missing" }],
    ["direct /404.html path", "/404.html", { kind: "missing" }],
    ["unknown path", "/nowhere", { kind: "missing" }],
  ])("matches %s", (_label, path, expected) => {
    expect(matchSitePage(path, files, docs)).toEqual(expected);
  });
});

describe("createPageRoute", () => {
  test("serves built pages, doc shells, redirects, and rewritten 404", async () => {
    const site = makeSite();
    const decorator = createPageDecorator(() => undefined);
    decorator.setNotice("<p>Warn</p>");
    const route = createPageRoute(async () => site, decorator, createResponder());

    const home = await route(parsedFor("http://admin.localhost/"));
    expect(await home.text()).toBe("<p>Home <p>Warn</p></p>");

    const doc = await route(parsedFor("http://admin.localhost/demo/doc/README"));
    expect(await doc.text()).toBe("<main><p>Doc body</p></main>");

    const dash = await route(parsedFor("http://admin.localhost/demo?who=A"));
    expect([dash.status, dash.headers.get("location")]).toEqual([
      302,
      "http://admin.localhost/demo/dashboard?who=A",
    ]);

    const missing = await route(parsedFor("http://admin.localhost/missing/x"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('<a href="/index.html">Hub</a> /missing/x');
  });

  test("answers 503 when loading the site fails", async () => {
    const route = createPageRoute(
      async () => {
        throw new Error("build failed: boom");
      },
      createPageDecorator(() => undefined),
      createResponder(),
    );
    const response = await route(parsedFor("http://admin.localhost/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(
      "The hub could not build its pages: build failed: boom.",
    );
  });
});
