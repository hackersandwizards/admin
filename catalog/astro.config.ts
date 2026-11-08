import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwind from "@tailwindcss/vite";
import { catalog } from "@hackersandwizards/scaffolding/catalog";
import { filesUnder, siteData, stylesheet } from "../src/build.ts";
import { fileHref, readRepo, treeSource } from "../src/repo.ts";

const root = join(import.meta.dirname, "..");
const cache = join(root, "node_modules/.cache/admin-catalog");
const fixture = join(root, "test/fixtures/spoke");
mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, "admin.css"), stylesheet());
writeFileSync(
  join(cache, "data.json"),
  JSON.stringify(siteData([await readRepo(fixture, treeSource(fixture))])),
);
process.env.ADMIN_DATA = join(cache, "data.json");

export default defineConfig({
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4332 },
  // admin-serve serves the build at /catalog/, under the hub's own home.
  base: "/catalog",
  outDir: join(root, "dist/catalog"),
  integrations: [
    // The pages link the fixture's files by file URL, which no http page opens: the build carries
    // them under /catalog/fixture/.
    {
      name: "admin-fixture-files",
      hooks: {
        "astro:build:done": ({ dir }) => {
          const out = fileURLToPath(dir);
          cpSync(fixture, join(out, "fixture"), { recursive: true });
          for (const f of filesUnder(out).filter((f) => f.endsWith(".html")))
            writeFileSync(
              f,
              readFileSync(f, "utf8").replaceAll(`${fileHref(fixture)}/`, "/catalog/fixture/"),
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
