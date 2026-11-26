import { assert, describe, expect, test, vi } from "vitest";
import { rejection } from "@hackersandwizards/scaffolding/rejection";
import { SHELL, shellPath } from "../src/build.ts";
import type { RepoData } from "../src/repo.ts";
import {
  astroAssetRoute,
  createCatalogRoute,
  createFileRoute,
  createPageRoute,
  createResponder,
  csp,
  isAllowedFetchSite,
  isCompressible,
  matchSitePage,
  parseRequest,
  responseHeaders,
  serveRepoFile,
  type PageMatch,
  type ParsedRequest,
} from "../src/serve-http.ts";
import {
  createDocFiller,
  createPageDecorator,
  indexDocs,
  linker,
  type Site,
} from "../src/serve-pages.ts";

const CATALOG_CSP = "object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'";
const HUB_CSP =
  "default-src 'self'; script-src http://admin.localhost/_astro/; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'self'; frame-ancestors 'self'";

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
  const docs = indexDocs([repo]);
  const shells = new Map([
    [shellPath("demo/", 3), `<main>${SHELL.html}<!--admin-notice--></main>`],
  ]);
  return {
    key: "k1",
    built: 1_000,
    files: new Map<string, Buffer>([
      ["index.html", Buffer.from("<p>Home <span data-stamp>old</span> <!--admin-notice--></p>")],
      ["robots.txt", Buffer.from("User-agent: * <!--admin-notice-->")],
      ["demo/dashboard.html", Buffer.from("<p>Dash</p>")],
      ["_astro/app.css", Buffer.from("body{}")],
      [
        "404.html",
        Buffer.from('<a href="index.html">Hub</a> admin-missing-path <!--admin-notice-->'),
      ],
    ]),
    repos: [repo],
    docs,
    docPage: createDocFiller(shells, docs, linker([repo])),
  };
};

describe("csp", () => {
  test("builds the hub content security policy for an origin", () => {
    expect(csp("http://admin.localhost")).toBe(HUB_CSP);
  });
});

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
    expect(responseHeaders("text/html", "no-store", CATALOG_CSP)).toEqual({
      "content-type": "text/html",
      "cache-control": "no-store",
      "content-security-policy": CATALOG_CSP,
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
  const bigHtml = "<p>hello</p>".repeat(200);

  test("gzips compressible built pages with no-store and hub CSP", async () => {
    const responder = createResponder();
    const req: ParsedRequest = {
      url: new URL("http://admin.localhost/"),
      path: "/",
      gzip: true,
      ifNoneMatch: null,
    };
    const res = responder.page(req, Buffer.from(bigHtml), "index.html");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(HUB_CSP);
    expect(Buffer.from(Bun.gunzipSync(await res.bytes())).toString("utf8")).toBe(bigHtml);
  });

  test("reuses cached gzip bytes across repeated page responses for the same buffer", async () => {
    const responder = createResponder();
    const body = Buffer.from(bigHtml);
    const req: ParsedRequest = {
      url: new URL("http://admin.localhost/"),
      path: "/",
      gzip: true,
      ifNoneMatch: null,
    };
    const gzipSpy = vi.spyOn(Bun, "gzipSync");
    try {
      const first = responder.page(req, body, "index.html");
      const second = responder.page(req, body, "index.html");
      expect(Buffer.from(Bun.gunzipSync(await first.bytes())).toString("utf8")).toBe(bigHtml);
      expect(Buffer.from(Bun.gunzipSync(await second.bytes())).toString("utf8")).toBe(bigHtml);
      expect(gzipSpy).toHaveBeenCalledTimes(1);
    } finally {
      gzipSpy.mockRestore();
    }
  });

  test.each<{
    label: string;
    gzip: boolean;
    body: Buffer;
    name: string;
  }>([
    { label: "client without gzip", gzip: false, body: Buffer.from(bigHtml), name: "index.html" },
    {
      label: "small html under threshold",
      gzip: true,
      body: Buffer.from("<p>hi</p>"),
      name: "index.html",
    },
    {
      label: "binary png over threshold",
      gzip: true,
      body: Buffer.alloc(2000, 7),
      name: "shot.png",
    },
  ])("serves $label uncompressed with exact bytes", async ({ gzip, body, name }) => {
    const responder = createResponder();
    const req: ParsedRequest = {
      url: new URL("http://admin.localhost/"),
      path: "/",
      gzip,
      ifNoneMatch: null,
    };
    const res = responder.page(req, body, name);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(Buffer.from(await res.bytes())).toEqual(body);
  });

  test("serves /_file/ responses uncompressed with no-cache and exact bytes", async () => {
    const responder = createResponder();
    const req: ParsedRequest = {
      url: new URL("http://admin.localhost/_file/demo/note.txt"),
      path: "/_file/demo/note.txt",
      gzip: true,
      ifNoneMatch: null,
    };
    const res = responder.file(req, Buffer.from(bigHtml), "note.txt");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toBe(HUB_CSP);
    expect(await res.text()).toBe(bigHtml);
  });

  test("sets catalog CSP and immutable cache for catalog _astro assets", () => {
    const responder = createResponder();
    const req: ParsedRequest = {
      url: new URL("http://admin.localhost/catalog/_astro/a.css"),
      path: "/catalog/_astro/a.css",
      gzip: false,
      ifNoneMatch: null,
    };
    const asset = responder.catalog(req, Buffer.from("body{}"), "_astro/a.css");
    const home = responder.catalog(req, Buffer.from("<p>hi</p>"), "index.html");
    expect(asset.headers.get("content-security-policy")).toBe(CATALOG_CSP);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(home.headers.get("cache-control")).toBe("no-store");
  });
});

describe("astroAssetRoute", () => {
  test("serves cached /_astro/ files immutably and returns undefined for misses", () => {
    const responder = createResponder();
    const site = makeSite();
    const cssReq: ParsedRequest = {
      url: new URL("http://admin.localhost/_astro/app.css"),
      path: "/_astro/app.css",
      gzip: false,
      ifNoneMatch: null,
    };
    const missReq: ParsedRequest = {
      url: new URL("http://admin.localhost/_astro/missing.css"),
      path: "/_astro/missing.css",
      gzip: false,
      ifNoneMatch: null,
    };
    const hit = astroAssetRoute(cssReq, site, responder);
    assert(hit, "expected asset hit");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(astroAssetRoute(missReq, site, responder)).toBeUndefined();
    expect(astroAssetRoute(cssReq, undefined, responder)).toBeUndefined();
  });
});

describe("serveRepoFile and createFileRoute", () => {
  test("returns 304 on matching etag and 200 with etag otherwise", async () => {
    const responder = createResponder();
    const body = Buffer.from("sample bytes");
    const first = await serveRepoFile(
      {
        url: new URL("http://admin.localhost/_file/demo/note.txt"),
        path: "/_file/demo/note.txt",
        gzip: false,
        ifNoneMatch: null,
      },
      body,
      responder,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"1fbmfdrc7cn9z"');

    const repeat = await serveRepoFile(
      {
        url: new URL("http://admin.localhost/_file/demo/note.txt"),
        path: "/_file/demo/note.txt",
        gzip: false,
        ifNoneMatch: '"1fbmfdrc7cn9z"',
      },
      body,
      responder,
    );
    expect(repeat.status).toBe(304);
    expect(repeat.headers.get("etag")).toBe('"1fbmfdrc7cn9z"');
  });

  test("ignores non-/_file/ paths synchronously, returns 404 when missing, and serves resolved files", async () => {
    const responder = createResponder();
    const site = makeSite();
    const known = new Map<string, Buffer>([["/r/demo:a.txt", Buffer.from("ok")]]);
    const route = createFileRoute(
      async () => site,
      responder,
      async (repo, p) => known.get(`${repo}:${p}`),
    );
    expect(
      route({
        url: new URL("http://admin.localhost/demo/dashboard"),
        path: "/demo/dashboard",
        gzip: false,
        ifNoneMatch: null,
      }),
    ).toBeUndefined();
    const miss = await route({
      url: new URL("http://admin.localhost/_file/demo/absent.txt"),
      path: "/_file/demo/absent.txt",
      gzip: false,
      ifNoneMatch: null,
    });
    assert(miss, "missing response");
    expect(miss.status).toBe(404);
    const hit = await route({
      url: new URL("http://admin.localhost/_file/demo/a.txt"),
      path: "/_file/demo/a.txt",
      gzip: false,
      ifNoneMatch: null,
    });
    assert(hit, "found response");
    expect(await hit.text()).toBe("ok");
  });
});

describe("createCatalogRoute", () => {
  test("ignores other paths synchronously, redirects /catalog with query, serves nested pages, and 404s unknown paths", async () => {
    const responder = createResponder();
    const files = new Map<string, Buffer>([
      ["index.html", Buffer.from("<p>Catalog</p>")],
      ["stories/a/index.html", Buffer.from("<p>Story</p>")],
    ]);
    const route = createCatalogRoute(async () => files, responder);

    expect(
      route({ url: new URL("http://admin.localhost/"), path: "/", gzip: false, ifNoneMatch: null }),
    ).toBeUndefined();
    const redirect = await route({
      url: new URL("http://admin.localhost/catalog?q=1"),
      path: "/catalog",
      gzip: false,
      ifNoneMatch: null,
    });
    assert(redirect, "redirect response");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("http://admin.localhost/catalog/?q=1");
    const story = await route({
      url: new URL("http://admin.localhost/catalog/stories/a"),
      path: "/catalog/stories/a",
      gzip: false,
      ifNoneMatch: null,
    });
    assert(story, "story response");
    expect(await story.text()).toBe("<p>Story</p>");
    const miss = await route({
      url: new URL("http://admin.localhost/catalog/missing"),
      path: "/catalog/missing",
      gzip: false,
      ifNoneMatch: null,
    });
    assert(miss, "miss response");
    expect(miss.status).toBe(404);
  });

  test("caches a failed catalog build as 503 with the exact same body on repeat requests", async () => {
    const load = vi.fn(async () => {
      throw new Error("catalog build failed: boom");
    });
    const route = createCatalogRoute(load, createResponder());
    const req: ParsedRequest = {
      url: new URL("http://admin.localhost/catalog/"),
      path: "/catalog/",
      gzip: false,
      ifNoneMatch: null,
    };
    const expectedBody =
      "catalog build failed: boom: the catalog builds with astrobook and @hackersandwizards/scaffolding installed beside this package; install them and restart admin-serve";
    const first = await route(req);
    const second = await route(req);
    assert(first, "first 503");
    assert(second, "second 503");
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(await first.text()).toBe(expectedBody);
    expect(await second.text()).toBe(expectedBody);
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
  test.each([
    {
      label: "strip-slash redirect",
      url: "http://admin.localhost/demo/dashboard/?who=A",
      path: "/demo/dashboard/",
      location: "http://admin.localhost/demo/dashboard?who=A",
    },
    {
      label: "dashboard redirect",
      url: "http://admin.localhost/demo?who=A",
      path: "/demo",
      location: "http://admin.localhost/demo/dashboard?who=A",
    },
  ])("handles $label with 302", async ({ url, path, location }) => {
    const site = makeSite();
    const route = createPageRoute(
      async () => site,
      createPageDecorator(() => undefined),
      createResponder(),
    );
    const res = await route({ url: new URL(url), path, gzip: false, ifNoneMatch: null });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(location);
  });

  test.each([
    {
      label: "stamped and noticed HTML file",
      url: "http://admin.localhost/",
      path: "/",
      expectedBody: "<p>Home <span data-stamp>10 Mar at 09:05</span> <p>Warn</p></p>",
    },
    {
      label: "unmodified non-HTML built file",
      url: "http://admin.localhost/robots.txt",
      path: "/robots.txt",
      expectedBody: "User-agent: * <!--admin-notice-->",
    },
    {
      label: "filled doc page with notice",
      url: "http://admin.localhost/demo/doc/README",
      path: "/demo/doc/README",
      expectedBody: "<main><p>Doc body</p><p>Warn</p></main>",
    },
  ])("responds with $label", async ({ url, path, expectedBody }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 2, 10, 9, 5).getTime());
    try {
      const site = makeSite();
      const decorator = createPageDecorator(() => undefined);
      decorator.setNotice("<p>Warn</p>");
      const route = createPageRoute(async () => site, decorator, createResponder());
      const res = await route({ url: new URL(url), path, gzip: false, ifNoneMatch: null });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(expectedBody);
    } finally {
      clock.mockRestore();
    }
  });

  test("starts loading the site synchronously and returns rewritten 404 with notice for missing paths", async () => {
    const site = makeSite();
    const loadSite = vi.fn(async () => site);
    const decorator = createPageDecorator(() => undefined);
    decorator.setNotice("<p>Warn</p>");
    const route = createPageRoute(loadSite, decorator, createResponder());

    const pending = route({
      url: new URL("http://admin.localhost/missing/x"),
      path: "/missing/x",
      gzip: false,
      ifNoneMatch: null,
    });
    expect(loadSite).toHaveBeenCalledTimes(1);
    const missing = await pending;
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('<a href="/index.html">Hub</a> /missing/x <p>Warn</p>');
  });

  test("answers 503 when loading the site rejects with an Error", async () => {
    const route = createPageRoute(
      async () => {
        throw new Error("build failed: boom");
      },
      createPageDecorator(() => undefined),
      createResponder(),
    );
    const response = await route({
      url: new URL("http://admin.localhost/"),
      path: "/",
      gzip: false,
      ifNoneMatch: null,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      "The hub could not build its pages: build failed: boom. It tries again a minute later, or once a repository changes.",
    );
  });

  test("does not answer 503 when loading the site rejects with a non-Error value", async () => {
    const route = createPageRoute(
      () => Promise.reject("not an error object"),
      createPageDecorator(() => undefined),
      createResponder(),
    );
    const err = await rejection(
      route({
        url: new URL("http://admin.localhost/"),
        path: "/",
        gzip: false,
        ifNoneMatch: null,
      }),
    );
    expect(err).toContain("undefined");
  });
});
