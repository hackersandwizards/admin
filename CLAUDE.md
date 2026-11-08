# CLAUDE.md

The admin engine, `@hackersandwizards/admin`: serves the hub across all repositories and checks item
files. The concept and its decisions are in os `docs/agent-work/2026-11-02-admin-engine.md`.

This repo is public on GitHub (`github.com/hackersandwizards/admin`), its history included. It
holds code only: no real item, report, client, person, deal, price or Company OS screenshot, in
code, fixtures, tests or commit messages. Fixtures use invented names.

Consumers install it as a Git dependency pinned to a tag, `#v<version>`. A release is a tag
`v<version>` matching `package.json`; renaming a command, changing its arguments or moving an
exported file is a release whose commit names the change.

## Layout

- `bin/`: the two commands. `src/`: item format and check (`items.ts`), reading a repository at
  HEAD or from the working tree (`repo.ts`), the hub's repository search (`hub.ts`), page data and
  the Astro build (`build.ts`), the hub's server (`serve.ts`).
- `site/`: the Astro site the build renders, brand's components and elements, and the shell's own
  layout (`site/src/layout.css`).
- `catalog/`: the catalog of the site's pages and components on the invented fixture, in
  scaffolding's catalog shell (`catalog()` preset). Its address is `/catalog/` on the hub
  (http://admin.localhost:4329/catalog/), which `admin-serve` builds from the package on the first
  request and links in the hub's menu; it needs astrobook and scaffolding installed beside the
  package. `bun run catalog` serves it live at http://127.0.0.1:4332/, `bun run build` writes it to
  `dist/catalog/`. Every component and page type has a story, guarded by `admin.test.ts`.
  `bun run dev` runs the hub (`admin-serve`) on 4329; `start` is its old name, kept while os's
  parallel-session skill names it. `brand-elements.json` lists the brand elements the site uses and the ones it keeps.
- `test/`: `admin.test.ts` and its invented fixtures; `no-values.ts`, the check that no design value
  lives here.
- `docs/agent-work/`: empty but for `.gitkeep`, since scaffolding's skeleton requires the folder; no
  item or report goes here.

## Checks

`bun run check` is the gate, `scaffolding check` from `@hackersandwizards/scaffolding`: the shared
steps, then `check:values` (no design value here), `check:colours` and `check:copies` (brand's
colour and copy scans), `check:fixture` (admin-check on the fixture), `check:elements`
(brand-elements over the built catalog, `dist` served so its pages answer at `/catalog/` as on the
hub), `check:markers` (brand-markers on the built doc and decisions pages, served the same way) and
`check:retired` (brand-retired over the built catalog).
The pre-commit hook runs scaffolding's `check-staged`.
