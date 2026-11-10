import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwind from "@tailwindcss/vite";
import { catalog } from "@hackersandwizards/scaffolding/catalog";
import { filesUnder, script, siteData, stylesheet } from "../src/build.ts";
import { fileHref, readRepo, treeSource } from "../src/repo.ts";

const root = join(import.meta.dirname, "..");
const cache = join(root, "node_modules/.cache/admin-catalog");
const fixture = join(root, "test/fixtures/spoke");
const base = "/catalog";
mkdirSync(cache, { recursive: true });
// The hub's catalog build and the gate's may load this config at once: each file is swapped in
// whole, so neither reads the other's half-written copy.
const put = (name: string, text: string) => {
  const part = join(cache, `${name}.${process.pid}`);
  writeFileSync(part, text);
  renameSync(part, join(cache, name));
};
put("admin.css", stylesheet());
put("admin.js", await script());
put("data.json", JSON.stringify(siteData([await readRepo(fixture, treeSource(fixture))])));
process.env.ADMIN_DATA = join(cache, "data.json");

export default defineConfig({
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4332 },
  // admin-serve serves the build at /catalog/, under the hub's own home.
  base,
  outDir: join(root, "dist/catalog"),
  integrations: [
    // The pages link the fixture's files by file URL, which no http page opens: the build links
    // the copies the preset's `copy` puts beside the pages.
    {
      name: "admin-fixture-links",
      hooks: {
        "astro:build:done": ({ dir }) => {
          for (const f of filesUnder(fileURLToPath(dir)).filter((f) => f.endsWith(".html")))
            writeFileSync(
              f,
              readFileSync(f, "utf8").replaceAll(
                `${fileHref(fixture)}/`,
                `${base}/test/fixtures/spoke/`,
              ),
            );
        },
      },
    },
    catalog({
      product: "Admin",
      admin: true,
      // Under admin-serve the lockup leads back to the hub; dev serves the catalog itself at /.
      href: "/",
      lead: "Every page and component of the admin engine, rendered by the engine's own site on an invented repository. Every value comes from brand.",
      css: [join(cache, "admin.css")],
      // As the admin pages set them (site/src/components/Layout.astro).
      storyScale: "dense",
      htmlClass: ["hw-focus-ring"],
      head: "./Head.astro",
      copy: ["test/fixtures/spoke/**"],
      home: "./Home.astro",
      groupOrder: ["Pages", "Shell", "Items"],
      // Every story is an Astro component: no story module, with its Node imports, reaches the browser.
      serverOnly: true,
      // admin.css carries brand's header.css already.
      header: { component: "@hackersandwizards/brand/expert/components/AppHeader.astro" },
    }),
  ],
  vite: {
    plugins: [tailwind()],
    resolve: {
      alias: {
        "admin:styles": join(cache, "admin.css"),
        "admin:script?url": `${join(cache, "admin.js")}?url`,
      },
    },
  },
});
