// The design system (decision design-system-tool): Astrobook over design-system/stories, served at
// http://127.0.0.1:4332/design-system/ by `bun run design-system`. The stories render the site's
// own components (site/src) on the invented fixture repository test/fixtures/spoke, read as the
// hub reads it, under the stylesheet the build writes. `astro build` writes the home to
// node_modules/.cache/design-system/, where brand-elements reads it from disk.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "astro/config";
import astrobook from "astrobook";
import tailwind from "@tailwindcss/vite";
import { siteData, stylesheet } from "../src/build.ts";
import { readRepo, treeSource } from "../src/repo.ts";

const root = join(import.meta.dirname, "..");
const cache = join(root, "node_modules/.cache/admin-design-system");
const fixture = join(root, "test/fixtures/spoke");
const outDir = join(root, "node_modules/.cache/design-system");
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
  outDir,
  // A page opened from disk finds its stylesheets by file URL.
  build: { assetsPrefix: pathToFileURL(outDir).href },
  integrations: [
    astrobook({
      directory: "stories",
      subpath: "/design-system",
      title: "Admin design system",
      css: [join(cache, "admin.css")],
      head: "./Head.astro",
      home: "./Home.astro",
    }),
  ],
  vite: {
    plugins: [tailwind()],
    resolve: { alias: { "admin:styles": join(cache, "admin.css") } },
  },
});
