# @hackersandwizards/admin

The admin engine: one admin area per repository and one hub across all of them. It holds code
only. Every item, report and image stays in the repository it belongs to.

## Install

A repository adds the package as a dev dependency pinned to a tag, as it does with brand:

```sh
bun add -d "git+https://github.com/hackersandwizards/admin.git#v0.3.0"
```

## Commands

| Command         | What it does                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `admin`         | Builds the admin pages of the current repository from its last commit into `node_modules/.cache/admin/`.             |
| `admin-serve`   | Serves the hub at `http://admin.localhost:4329` from each repository's HEAD, rebuilt when one moves. Writes no file. |
| `admin-check`   | Checks the item files in the working tree. Exit 1 on a defect. Belongs in every repository's gate.                   |
| `admin-migrate` | Converts `GOAL.md`, `docs/tracking/decisions/items.js` and review folders into item files, once per repository.      |

`bun run start` in this checkout runs `admin-serve`, the one hub: open `http://admin.localhost:4329`.
A repository shows in the hub when its HEAD has `docs/tracking/items/` or its `package.json` names an
`@hackersandwizards` package, so this engine shows itself.

A repository gets a Design system entry when an `astro.config.*` at its root or one folder down loads
Astrobook: the link is `http://127.0.0.1:<port><base><subpath>` from that config, and the page names
the package script that starts it and says whether it is running now. `admin.designSystem` overrides
it.

Answers to decisions stay in the browser until "Copy answers" puts
them on the clipboard as one `repo:id: choice, note` line each.

## Item files

One Markdown file per item in `docs/tracking/items/<id>.md`. Git history is the log. A decided or
finished item is deleted in the commit that carries it out.

```md
---
kind: decision # decision | review | work | goal
status: open # open | assumed | decided
priority: 2 # 1 to 3, 1 costs most if missed; not on a goal
owner: Alex # who answers, or for work who moves next
area: product # optional
recommended: a # optional, an option key
options:
  - key: a
    label: Variant A
    detail: What choosing it changes.
  - key: b
    label: Variant B
images: # optional, option key to a repo-relative image
  a: docs/tracking/2026-01-15-topic/variant-a.jpg
---

# Which variant ships?

The question's context, in Markdown.
```

`admin-check` enforces:

- `kind`, `status` and, except on a goal, `priority` and `owner` are present and valid. Unknown
  fields are defects.
- An open decision has at least two options. A request to look at something is `kind: review`.
- `recommended` and every `images` key name an option. Every image and `page` path exists.
- An `assumed` item states `assumption` or `recommended`. A `decided` item states `decision` and
  `by`, and may quote the person in `quote`.
- Work and goals are only ever `open`.
- `due` is an ISO date. `order`, `evidence` and `page` are optional.
- No `GOAL.md` or `docs/tracking/decisions/items.js` remains.

## The admin area

Dashboard, Decisions, Work, Reviews (each `docs/tracking/<date>-<topic>/` folder with its images
and report), Docs (reports and the rest of `docs/`), Design system, the repository's products,
Architecture (package, pins, scripts with their first comment line), Checks (the steps of
`check:all` or `check`) and Log.

A repository configures what convention cannot find under `admin` in its `package.json`:

```json
{
  "admin": {
    "designSystem": "catalogue.html",
    "products": [{ "label": "Slide types", "href": "specimen/index.html" }],
    "links": [{ "label": "Validation", "href": "http://127.0.0.1:4321/validation" }],
    "name": "os"
  }
}
```

An `href` without a scheme is a path in the repository: the hub serves it from HEAD, and a file it
links under `node_modules/` from the installed package.

## Design values

The pages take every colour, size and font from `@hackersandwizards/brand`: tokens, the expert
set, the shared elements at the dense scale and the internal header. `bun test/no-values.ts`
fails on a value defined here.

## Development

```sh
bun install
bun run check
```
