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
  scaffolding's catalog shell (`catalog()` preset); its address on the hub is in `docs/hub.md`.
  `bun run catalog` serves it live at http://127.0.0.1:4332/ (restart it after editing
  `site/src/admin.js`, bundled at start), `bun run build` writes it to `dist/catalog/`. Every component and page type has a story, guarded by `admin.test.ts`.
  `bun run dev` runs the hub (`admin-serve`) on 4329; `start` is its old name, kept while os's
  admin-engine concept names it. `brand-elements.json` lists the brand elements the site uses and the ones it keeps, and holds the
  catalog's Content-Security-Policy (`csp`), which `serve.ts` sends and extends for the hub's pages.
- `test/`: `admin.test.ts` and its invented fixtures; `no-values.ts`, the check that no design value
  lives here.
- `docs/`: `items.md`, what `admin-check` enforces, and `hub.md`, what the hub does and reads from a
  repository's `package.json` or `docs/agent-work/admin.json`. The README links them and holds no reference of its own.
  `<date>-performance.md` is the last polish's measurements, replaced by the next.
- `docs/agent-work/`: empty but for `.gitkeep`, since scaffolding's skeleton requires the folder; no
  item or report goes here.

## Design values

The pages take every colour, size and font from `@hackersandwizards/brand`: tokens, the expert
set, the shared elements at the dense scale and the internal header. The one exception is the
shell's layout, `site/src/layout.css`: the rail's and the page's lengths are the admin's own, its
colours and type roles brand's. `bun run check:values` fails on a colour, a custom property or a
Tailwind arbitrary value defined here.

## Pages

A control that commits an answer (an option, Pick recommended, Agree or Veto, Decide later, done)
sits only where the text it answers is on screen: in the opened row, never on a closed row.

## Checks

`bun run check` is the gate, `scaffolding check` from `@hackersandwizards/scaffolding`: the shared
steps, then `check:values` (no design value here), `check:colours`, `check:copies` and
`check:scan` (brand's colour, copy and expert-component scans), `check:fixture` (admin-check on the fixture), `check:elements`
(brand-elements over the built catalog, `dist` served so its pages answer at `/catalog/` as on the
hub) and `check:retired` (brand-retired over the built catalog). `check:markers` (brand-markers on
the built doc and decisions pages, served the same way) stays out of the gate: run it after a brand
raise and after a change to how lists are styled.
The pre-commit hook runs scaffolding's `check-staged`.
