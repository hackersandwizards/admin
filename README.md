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
range shares its copy instead of getting a second Astro under admin. All four are optional, so a
repository that only runs `admin-check` installs none of them, and `admin-serve` stops and names
them when they are missing or outside their range.

Requirements: bun 1.4 or newer, and Git on the `PATH`: every command reads repositories through it.

## Commands

| Command                                   | What it does                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-serve [--root <dir>] [--port <n>]` | Serves the hub at `http://admin.localhost:4329` for the repositories under `~/dev`, each from its HEAD and rebuilt when one moves. Writes nothing into the repositories it reads: it builds in a `site/.build-*` folder inside the package, which a killed hub leaves behind, and keeps the catalog's cache in the package's `node_modules/.cache/admin-catalog`. |
| `admin-check [<repo>...]`                 | Checks the item files in the working tree, default the current directory. Exit 1 on a defect. Belongs in every repository's gate.                                                                                                                                                                                                                                 |

`bun run dev` in this checkout runs `admin-serve`, the one hub: open `http://admin.localhost:4329`.
One repository's own pages open at `http://admin.localhost:4329/<repo>`, such as `/website`,
which leads to its dashboard with only its items. `<repo>` is the folder name, or `admin.name` in
its `package.json`; where two checkouts share it, or it names a page of the hub (`index`,
`architecture`, `catalog`), the parent folder's name goes before it and the repository shows a
defect. The hub's rail and its Repositories table link every repository's dashboard.
The engine's own catalog, every page and component on an invented repository, opens at
`http://admin.localhost:4329/catalog/`, linked in the hub's rail. `admin-serve` builds it from the
package on its first request, which needs `astrobook` and `@hackersandwizards/scaffolding`
installed beside the package; without them the address answers 503 and names both.
A repository shows in the hub when its HEAD has `docs/agent-work/items/` or its `package.json` names an
`@hackersandwizards` package, so this engine shows itself.

An item's body is Markdown without HTML: a tag in it, such as a placeholder `<id>`, shows as
written, and a web address in angle brackets is a link. A doc keeps its raw HTML, styles and images
included, but no script in it runs:
the hub's content security policy runs only its own build under `/_astro/`, so a `.js` file a
repository commits and links through `/_file/` stays inert. Nor can a doc send the page
elsewhere: the policy lets no form post and no frame load from another site, and a `<meta>` tag
in a doc shows as text. Images, fonts and stylesheets load only from the hub itself, committed
images included, so a doc's image or `url()` from another site stays blank. A committed `.html`
file opened through `/_file/` is served as written. A page on another site, or on another port of
this machine, may link the hub, but the hub refuses its scripts, images and fetches, which would
learn from what loads which repositories and files exist.

A repository gets a Catalog entry when an `astro.config.*` at its root or one folder down loads
Astrobook or scaffolding's catalog preset, at `http://127.0.0.1:<port>` from that config: at
`/catalog/` for the preset (v2 or later), which answers there whether its catalog is the site's
home or sits under `/catalog/`, and at `<base><subpath>` for Astrobook. The page names the package
script that starts it (`catalog` where the preset's repository has one) and says whether it is
running now.
`admin.designSystem` overrides it.

Answers to decisions stay in the browser as they are typed, across reloads and with no prompt on
leaving, until "Copy answers", on every page that lists questions, puts them on the clipboard as
one `repo:id: choice, note` line each, in the page's order, each picked key with its label as
answered: `repo:id: a (Label A), b (Label B), note`. A copy holds the answers not copied yet, and
all of them again once none is new. An answer keeps the item's title and options it answered: where
they changed since, its row shows the pick as given and asks for a new answer, and its line ends
`; answered <time>, before the question or its options changed`, which the agent checks against
the item before it acts. An assumption is answered "Agree" or "Veto", which leads its line:
`repo:id: veto, b (Label B), note`. "Decide later" puts a question off: it stays out of the copy,
and the next visit, a page view more than an hour after the last, asks it again, with a note
written beside it as its answer.

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
- An option's `key` is one word, without a comma or space. `label`, `detail`, `area`, `owner`,
  `assumption`, `decision`, `by`, `quote` and `evidence` are text.
- `score` and `noise` are numbers; `noise` needs a `score`.
- An `assumed` item states `assumption` or `recommended`. A `decided` item states `decision` and
  `by`, and may quote the person in `quote`.
- Work and goals are only ever `open`.
- `due` is a calendar day as an ISO date. `order` and `evidence` are optional.
- A table, such as scores per criterion, goes in the body as Markdown.
- No `GOAL.md` or `docs/tracking/decisions/items.js` remains.

## The admin area

Dashboard, Decisions, Work, Reviews (open review requests and open decisions between images, then
each `docs/agent-work/<date>-<topic>/` folder with its images and report), Docs (reports and the rest of `docs/`, a fold per folder, open where it holds ten docs or fewer), Catalog, the repository's products,
Architecture (package, pins, scripts with their first comment line), Checks (the steps of
`check:all` or `check`) and Log.

Items sort by `priority`, then `order`; a `due` date seven days away or nearer, or past, leads its
priority, and every `due` shows as a badge: "was due" in red once past, "due today" in amber. On
the hub every repository's rows run in this one order, each naming its repository, and assumed and
decided items come last, under "Settled", each saying what was assumed or decided.
Work an agent owns shows collapsed under "Agents on it", each row a link to its repository's
page. An item belongs to the first person its `owner` names anywhere ("Ivo drafts, Kim sends" is
Kim's), a person being the hub's user or a name that opens some open item's owner, and never an
agent's name, one an agent definition gives or Claude or Codex; a name matches only whole. The hub and each
dashboard list open items people other than the hub's user own under "Waiting on others"; the
hub's user is the machine's git identity by first name where an owner writes it, else the person
with the most open questions. On the hub and Decisions a row of buttons for every person who owns
an open item, the hub's user first, filters the items by owner, and a second row by kind, each
with its count of open items for that person; a new visit starts on the hub's user again. A row
whose item file changed since the visit before, a run of page views under an hour apart in this
browser, says so, and whether its question or options changed; each fold counts such rows. An
opened question shows its first paragraph, its options and its buttons before the rest of its
text. A page left open over an hour says so.

When a build fails or a repository cannot be read at its HEAD, every page says so above its
content, keeps the last pages it built, and the hub tries again a minute later, or once a
repository changes. A fetch that moves no ref builds nothing: the page prints the new fetch time
as it is served. A
relative link from one doc to another opens that doc's page.

In an item's text a path under `docs/agent-work/` links into the repository named right
before it (``website `docs/agent-work/…` ``) or after it (`` `…` in website ``), else into the
item's own, and stays text where that repository holds no such file. A Markdown link relative to
the item file resolves from `docs/agent-work/items/`.

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
