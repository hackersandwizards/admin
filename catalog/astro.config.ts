// The catalog (repo-uniformity-plan, hub-max): Astrobook over catalog/stories in scaffolding's
// catalog shell, served at http://127.0.0.1:4332/catalog/ by `bun run catalog`. The stories render
// the site's own components (site/src) on the invented fixture repository test/fixtures/spoke, read
// as the hub reads it, under the stylesheet the build writes. `bun run build` writes dist/, where
// brand-elements reads the pages from disk; nothing publishes it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "astro/config";
import tailwind from "@tailwindcss/vite";
import { catalog } from "@hackersandwizards/scaffolding/catalog";
import { siteData, stylesheet } from "../src/build.ts";
import { readRepo, treeSource } from "../src/repo.ts";

const root = join(import.meta.dirname, "..");
const cache = join(root, "node_modules/.cache/admin-catalog");
const fixture = join(root, "test/fixtures/spoke");
mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, "admin.css"), stylesheet());
writeFileSync(
  join(cache, "data.json"),
  JSON.stringify(siteData([readRepo(fixture, treeSource(fixture))], true)),
);
process.env.ADMIN_DATA = join(cache, "data.json");

export default defineConfig({
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4332 },
  // A page opened from disk finds its stylesheets by file URL.
  build: { assetsPrefix: pathToFileURL(join(root, "dist")).href },
  redirects: { "/design-system": "/catalog" },
  integrations: [
    catalog({
      product: "Admin",
      lead: "Every page and component of the admin engine, rendered by the engine's own site on an invented repository. Every value comes from brand.",
      css: [join(cache, "admin.css")],
      head: "./Head.astro",
      home: "./Home.astro",
      groupOrder: ["Pages", "Shell", "Items"],
      // admin.css carries brand's header.css already.
      header: { component: "@hackersandwizards/brand/expert/components/AppHeader.astro" },
    }),
  ],
  vite: {
    plugins: [tailwind()],
    resolve: { alias: { "admin:styles": join(cache, "admin.css") } },
  },
});
