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
  JSON.stringify(siteData([readRepo(fixture, treeSource(fixture))])),
);
process.env.ADMIN_DATA = join(cache, "data.json");

export default defineConfig({
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4332 },
  // A page opened from disk finds its stylesheets by file URL.
  build: { assetsPrefix: pathToFileURL(join(root, "dist")).href },
  integrations: [
    catalog({
      product: "Admin",
      admin: true,
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
