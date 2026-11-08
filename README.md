# @hackersandwizards/admin

The admin engine: one admin area per repository and one hub across all of them. It holds code
only. Every item, report and image stays in the repository it belongs to.

## Install

A repository adds the package as a dev dependency pinned to a tag. The repository is public, so
the install needs no GitHub login:

```sh
bun add -d "git+https://github.com/hackersandwizards/admin.git#v<version>"
```

`<version>` is the newest of the
[repository's tags](https://github.com/hackersandwizards/admin/tags).

`@hackersandwizards/brand` is a peer dependency: the repository pins it itself, and admin uses
that copy, so no second copy lands under `node_modules/@hackersandwizards/admin/`. It is marked
optional, so bun never looks it up on the npm registry, where the package does not exist.
`admin-check` does not need it; `admin-serve` stops and names what to pin when it is missing or
older than its peer range, which bun does not check for a Git pin (older brand draws P3 as the
outline that means unset). The versions in admin's `devDependencies` are the tested set.

`astro`, `tailwindcss`, `@tailwindcss/vite` and `@tailwindcss/typography`, which `admin-serve`
builds the pages with, are peer dependencies too: a repository on another version within the
range shares its copy instead of getting a second Astro under admin. bun installs Astro where it is
missing, and one outside the range gets bun's peer warning and builds with its own, untested
version. The three Tailwind packages are optional, so a repository that only runs `admin-check`
installs none of them, and `admin-serve` stops and names them when they are missing or outside
their range.

Requirements: bun 1.4 or newer, and Git on the `PATH`: every command reads repositories through it.

## Commands

| Command                                   | What it does                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-serve [--root <dir>] [--port <n>]` | Serves the hub at `http://admin.localhost:4329` for the repositories under `~/dev`, each from its HEAD and rebuilt when one moves. Writes no file. |
| `admin-check [<repo>...]`                 | Checks the item files in the working tree, default the current directory. Exit 1 on a defect. Belongs in every repository's gate.                  |

`bun run dev` in this checkout runs `admin-serve`, the one hub: open `http://admin.localhost:4329`.
One repository's own pages open at `http://admin.localhost:4329/<repo>`, such as `/website`,
which leads to its dashboard with only its items. `<repo>` is the folder name, or `admin.name` in
its `package.json`. The hub's rail and its Repositories table link every repository's dashboard.
The engine's own catalog, every page and component on an invented repository, opens at
`http://admin.localhost:4329/catalog/`, linked in the hub's rail. `admin-serve` builds it from the
package on its first request, which needs `astrobook` and `@hackersandwizards/scaffolding`
installed beside the package; without them the address answers 503 and names both.
A repository shows in the hub when its HEAD has `docs/agent-work/items/` or its `package.json` names an
`@hackersandwizards` package, so this engine shows itself.

Item and doc bodies keep their raw HTML, styles and images included, but no script in them runs:
the hub's content security policy runs only its own build under `/_astro/`, so a `.js` file a
repository commits and links through `/_file/` stays inert. Nor can a body send the page
elsewhere: the policy lets no form post and no frame load from another site, and a `<meta>` tag
in a body shows as text. A committed `.html` file opened through `/_file/` is served as written.

A repository gets a Catalog entry when an `astro.config.*` at its root or one folder down loads
Astrobook or scaffolding's catalog preset, at `http://127.0.0.1:<port>` from that config: at
`/catalog/` for the preset (v2 or later), which answers there whether its catalog is the site's
home or sits under `/catalog/`, and at `<base><subpath>` for Astrobook. The page names the package
script that starts it (`catalog` where the preset's repository has one) and says whether it is
running now.
`admin.designSystem` overrides it.

Answers to decisions stay in the browser as they are typed, across reloads and with no prompt on
leaving, until "Copy answers", on every page that lists questions, puts them on the clipboard as
one `repo:id: choice, note` line each.

## Item files

One Markdown file per item in `docs/agent-work/items/<id>.md`, its images beside it in
`docs/agent-work/items/<id>/`. Git history is the log. A decided or finished item is deleted, with
its image folder, in the commit that carries it out. The admin renders every review from this
data in its own styles: no repository holds review HTML, and `admin-serve` copies no image out of
the repository.

```md
---
kind: decision # decision | review | work | goal
status: open # open | assumed | decided
priority: 2 # 1 to 3, 1 costs most if missed; not on a goal
owner: Alex # who answers, or for work who moves next
area: product # optional
recommended: a # optional, an option key; a list where multiple is true
multiple: false # optional, true lets the person pick several options
options:
  - key: a
    label: Variant A
    detail: What choosing it changes.
    score: 8.4 # optional, the blind-review score
    noise: 0.5 # optional, the spread measured around it
  - key: b
    label: Variant B
images: # optional, option key to one image or a list
  a: variant-a.jpg # a file name in docs/agent-work/items/<id>/
  b:
    - src: variant-b-light.jpg
      caption: light, 600 px
    - src: variant-b-dark.jpg
      caption: dark, 600 px
---

# Which variant ships?

The question's context, in Markdown.
```

`admin-check` enforces:

- `kind`, `status` and, except on a goal, `priority` and `owner` are present and valid. Unknown
  fields are defects.
- An open decision has at least two options. A request to look at something is `kind: review`.
- `recommended` and every `images` key name an option; several recommended need `multiple: true`.
  `images` may instead be a list: images of the item as a whole, shown under its text.
- An image is a file name in the item's folder, or `{src, caption}`; a value with a slash is read
  from the repository root, as items written before the folder did. Every image exists, and an
  image folder whose item is gone is a defect.
- `score` and `noise` are numbers; `noise` needs a `score`.
- An `assumed` item states `assumption` or `recommended`. A `decided` item states `decision` and
  `by`, and may quote the person in `quote`.
- Work and goals are only ever `open`.
- `due` is an ISO date. `order` and `evidence` are optional.
- A table, such as scores per criterion, goes in the body as Markdown.
- No `GOAL.md` or `docs/tracking/decisions/items.js` remains.

## The admin area

Dashboard, Decisions, Work, Reviews (every item with images, then each older
`docs/agent-work/<date>-<topic>/` folder with its images and report), Docs (reports and the rest of `docs/`), Catalog, the repository's products,
Architecture (package, pins, scripts with their first comment line), Checks (the steps of
`check:all` or `check`) and Log.

A repository configures what convention cannot find under `admin` in its `package.json`:

```json
{
  "admin": {
    "designSystem": "https://hackersandwizards.github.io/slides/catalog/",
    "products": [
      { "label": "Slide types", "href": "https://hackersandwizards.github.io/slides/catalog/" }
    ],
    "links": [{ "label": "Validation", "href": "http://127.0.0.1:4321/validation" }],
    "name": "os"
  }
}
```

An `href` without a scheme is a path in the repository: the hub serves it from HEAD, and a file it
links under `node_modules/` from the installed package.

## Design values

The pages take every colour, size and font from `@hackersandwizards/brand`: tokens, the expert
set, the shared elements at the dense scale and the internal header. The one exception is the
shell's layout, `site/src/layout.css`: the rail's and the page's lengths are the admin's own, its
colours and type roles brand's. `bun run check:values` fails on a colour, a custom property or a
Tailwind arbitrary value defined here.

## Development

```sh
bun install
bun run check     # the gate: scaffolding's shared steps, then the steps in package.json's scaffolding.check
bun run dev       # the hub on http://admin.localhost:4329
bun run catalog   # the catalog live, http://127.0.0.1:4332/; on the hub it is /catalog/
```

## License

[PolyForm Strict 1.0.0](LICENSE): free for noncommercial and personal use, no redistribution or
derived works, plus a permission for trainers hackers&wizards commissions. The name hackers&wizards
and its logos are not licensed.
