# CLAUDE.md

The admin engine, `@hackersandwizards/admin`: builds each repository's admin pages and the hub
across all repositories, checks item files, and migrates legacy tracking. The concept and its
decisions are in os `docs/tracking/2026-11-02-admin-engine.md`.

This repo is public on GitHub (`github.com/hackersandwizards/admin`), its history included. It
holds code only: no real item, report, client, person, deal, price or Company OS screenshot, in
code, fixtures, tests or commit messages. Fixtures use invented names.

Consumers install it as a Git dependency pinned to a tag, `#v<version>`. A release is a tag
`v<version>` matching `package.json`; renaming a command, changing its arguments or moving an
exported file is a release whose commit names the change.

## Layout

- `bin/`: the four commands. `src/`: item format and check (`items.ts`), reading a repository at
  HEAD or from the working tree (`repo.ts`), the hub's repository search (`hub.ts`), page data and
  the Astro build (`build.ts`), the migrator (`migrate.ts`).
- `site/`: the Astro site the build renders, brand's components and elements only.
- `test/`: `admin.test.ts` and its invented fixtures; `no-values.ts`, the check that no design value
  lives here.

## Checks

`bun run check` is the gate; the pre-commit hook runs it after a staged gitleaks scan.
