import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { docSlug } from "./repo-paths.ts";
import type { SiteData } from "./site-data.ts";

export const PKG = join(import.meta.dirname, "..");

// Only topic reports are built as individual doc pages. The hub fills every other doc on
// request from its repository's shell, built once per folder depth so its relative links work.
export const SHELL = {
  name: "admin-shell-name",
  path: "admin-shell-path",
  title: "admin-shell-title",
  titleId: "admin-shell-anchor",
  html: "admin-shell-html",
};
export const shellPath = (prefix: string, depth: number) =>
  `${prefix}_shell/${"_/".repeat(depth - 3)}${SHELL.name}`;

export function shelled(data: SiteData): SiteData {
  const docs = data.pages.filter((p) => p.type === "doc" && !p.topic);
  const pages = data.pages.filter((p) => p.type !== "doc" || p.topic);
  const topicDocs = new Set(pages.filter((p) => p.topic).map((p) => p.path));
  const repos = data.repos.map((r) => {
    for (const depth of new Set(
      docs.filter((p) => p.repo === r.key).map((p) => p.path.split("/").length),
    ))
      pages.push({
        path: shellPath(r.prefix, depth),
        type: "doc",
        repo: r.key,
        title: SHELL.title,
        article: SHELL,
      });
    return {
      ...r,
      reports: r.reports.map((d) =>
        topicDocs.has(r.prefix + docSlug(d.path)) ? d : { ...d, html: "" },
      ),
      docs: r.docs.map((d) => ({ ...d, html: "" })),
    };
  });
  return { ...data, repos, pages };
}

// Every path is resolved, since the package may sit hoisted or nested.
export function stylesheet() {
  const at = (spec: string) => Bun.resolveSync(spec, PKG);
  // Knip credits Tailwind dependencies only through createRequire.
  const require = createRequire(import.meta.url);
  const brandRoot = dirname(at("@hackersandwizards/brand/package.json"));
  return [
    `@import "${require.resolve("tailwindcss/index.css")}";`,
    `@plugin "${require.resolve("@tailwindcss/typography")}";`,
    `@import "${at("@hackersandwizards/brand/tokens.css")}";`,
    `@import "${at("@hackersandwizards/brand/expert.css")}";`,
    `@import "${at("@hackersandwizards/brand/header.css")}";`,
    `@import "${at("@hackersandwizards/brand/elements.css")}";`,
    `@import "${at("@hackersandwizards/brand/marker.css")}";`,
    `@import "${at("@hackersandwizards/brand/fonts.css")}";`,
    `@import "${join(PKG, "site/src/layout.css")}";`,
    `@source "${join(PKG, "site/src")}";`,
    `@source "${join(brandRoot, "expert")}";`,
    `@source "${join(brandRoot, "elements")}";`,
    `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`,
  ].join("\n");
}

export async function script() {
  const { outputs } = await Bun.build({
    entrypoints: [join(PKG, "site/src/admin.js")],
    format: "iife",
    minify: true,
  });
  const [output] = outputs;
  if (output === undefined) throw new Error("Build output missing: site/src/admin.js");
  return output.text();
}

export function writeSiteData(file: string, data: SiteData) {
  // From disk 'self' admits every file:// script, a doc's committed one included, and a
  // hash needs CORS there, so a per-build nonce marks the pages' own.
  writeFileSync(file, JSON.stringify({ ...data, nonce: crypto.randomUUID() }));
}

// Builds the pages into `outDir`. Astro writes absolute /_astro/ URLs; each page gets them
// relative, so the folder opens from disk and can move.
export async function buildSite(data: SiteData | { file: string }, outDir: string) {
  // Astro bundles a prerender entry beside its output when that sits inside the working
  // directory, and resolves its packages from there, so the build runs in a folder inside this
  // package, where node resolution reaches the package's dependencies, nested or hoisted. Its
  // .astro folder lands there too, never in the spoke.
  const work = mkdtempSync(join(PKG, "site", ".build-"));
  const built = join(work, "out");
  const cwd = process.cwd();
  process.chdir(work);
  try {
    const file = "file" in data ? data.file : join(work, "data.json");
    if (!("file" in data)) writeSiteData(file, data);
    writeFileSync(join(work, "admin.css"), stylesheet());
    writeFileSync(join(work, "admin.js"), await script());
    process.env.ADMIN_DATA = file;
    const { build } = await import("astro");
    const tailwind = (await import("@tailwindcss/vite")).default;
    await build({
      root: join(PKG, "site"),
      configFile: false,
      outDir: built,
      cacheDir: join(work, "cache"),
      logLevel: "error",
      build: { format: "file", inlineStylesheets: "never" },
      vite: {
        cacheDir: join(work, "vite"),
        plugins: [tailwind()],
        resolve: {
          alias: {
            "admin:styles": join(work, "admin.css"),
            "admin:script?url": `${join(work, "admin.js")}?url`,
          },
        },
        build: { assetsInlineLimit: 0 },
      },
    });
    rmSync(join(built, ".prerender"), { recursive: true, force: true });
    relativize(built);
    cpSync(built, outDir, { recursive: true });
  } finally {
    process.chdir(cwd);
    rmSync(work, { recursive: true, force: true });
  }
}

// The engine's own catalog, as `bun run build` builds it, into `outDir`, run from the package with
// caches beside the output, so a build the gate runs meanwhile keeps its own.
export async function buildCatalog(outDir: string) {
  const { build } = await import("astro");
  process.chdir(PKG);
  await build({
    root: join(PKG, "catalog"),
    outDir,
    cacheDir: join(outDir, "..", "cache"),
    logLevel: "error",
    vite: { cacheDir: join(outDir, "..", "vite") },
  });
}

export const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

function relativize(outDir: string) {
  for (const file of filesUnder(outDir)) {
    if (file.endsWith(".html")) {
      const up = relative(dirname(file), outDir) || ".";
      const html = readFileSync(file, "utf8").replaceAll('"/_astro/', `"${up}/_astro/`);
      writeFileSync(file, html);
    } else if (file.endsWith(".css")) {
      writeFileSync(file, readFileSync(file, "utf8").replaceAll("/_astro/", "./"));
    }
  }
}
