# The hub

What `admin-serve` serves, how its pages behave and what a repository configures. How to start it:
[README](../README.md#run-the-hub).

## Run it

`admin-serve [--root <dir>] [--port <n>]`: Serves the hub at `http://admin.localhost:4329` for the repositories under `~/dev`, each from its
HEAD and rebuilt when one moves. Writes nothing into the repositories it reads: it builds in a
`site/.build-*` folder inside the package, which a killed hub leaves behind, and keeps the
catalog's cache in the package's `node_modules/.cache/admin-catalog`.

`@hackersandwizards/brand` is a peer dependency: the repository pins it itself, and admin uses that
copy, so no second copy lands under `node_modules/@hackersandwizards/admin/`. It is marked optional,
so bun never looks it up on the npm registry, where the package does not exist. `admin-check` does
not need it; `admin-serve` stops and names what to pin when it is missing or older than its peer
range, which bun does not check for a Git pin (older brand breaks a rail count onto two lines,
lacks the focus ring's room the rail is laid out by, and shows the skip link at all times). The versions in admin's `devDependencies` are
the tested set.

`astro`, `tailwindcss`, `@tailwindcss/vite` and `@tailwindcss/typography`, which `admin-serve`
builds the pages with, are peer dependencies too: a repository on another version within the
range shares its copy instead of getting a second Astro under admin. All four are optional, so a
repository that only runs `admin-check` installs none of them, and `admin-serve` stops and names
them when they are missing or outside their range.

## Addresses

One repository's own pages open at `http://admin.localhost:4329/<repo>`, such as `/website`,
which leads to its dashboard with only its items. `<repo>` is `admin.name` in its
`package.json` where that holds only letters, digits, `.`, `_` and `-`, and not only dots
(otherwise a defect); else the folder name, every other character as `-`; where two checkouts share it, or it names a page
or route of the hub (`index`, `architecture`, `404`, `catalog`, `_astro`, `_file`), the parent
folder's name goes before it and the repository shows a defect. The hub's rail and its Repositories table link every repository's dashboard.
The engine's own catalog, every page and component on an invented repository, opens at
`http://admin.localhost:4329/catalog/`, linked in the hub's rail. `admin-serve` builds it from the
package on its first request, which needs `astrobook` and `@hackersandwizards/scaffolding`
installed beside the package; without them the address answers 503 and names both.
A repository shows in the hub when its HEAD has `docs/agent-work/items/` or its `package.json` names an
`@hackersandwizards` package, so this engine shows itself.

## The admin area

Dashboard, Decisions, Work, Reviews (open review requests and open decisions between images, then
each `docs/agent-work/<date>-<topic>/` folder with its images and report), Docs (reports, the rest of `docs/` and the Markdown files at the root, a fold per folder, open where it holds ten docs or fewer), Catalog, the repository's products,
Architecture (package, pins, scripts with their first comment line), Checks (the steps of
`check:all` or `check`) and Log.

Items sort by `priority`, then `order`; a `due` date seven days away or nearer, or past, leads its
priority, and every `due` shows as a badge: "was due" in red once past, "due today" in amber. On
the hub every repository's rows run in this one order, each naming its repository, and assumed and
decided items come last, under "Settled", each saying in two lines at most what was assumed or
decided, in full once opened.
Work an agent owns shows collapsed under "Agents on it", each row a link to its repository's
page. An item belongs to the first person its `owner` names anywhere ("Ivo drafts, Kim sends" is
Kim's), a person being the hub's user or a name that opens some open item's owner, and never an
agent's name, one an agent definition gives or Claude or Codex; a name matches only whole. An owner
naming no person and not starting like an agent ("an agent", "Agent (…)") is a company or a team,
such as `B+L` or `eBike Works`: it keeps its name up to the first comma, semicolon or `(`, has no button,
and its items wait under "Waiting on others" and show under "All". The hub and each
dashboard list open items people other than the hub's user own under "Waiting on others", and a
dashboard's "Most urgent" holds only the hub's user's and the agents' five most urgent; the
hub's user is the machine's git identity by first name where an owner writes it, else the person
with the most open questions. On the hub and Decisions a row of buttons for every person who owns
an open item, the hub's user first, filters the items by owner, each with that person's count of
open items and "All" with every one, the rail's count while no repository is hidden, and a second row by kind, each
with its count of open items for that person; a new visit starts on the hub's user again. On the hub
a third control, "Which repositories", opens a box per repository: one unchecked hides that
repository's rows from every list on the hub, whatever person and kind are chosen, and the person
and kind counts count only the repositories shown. The choice stays in this browser across visits; while
any is hidden, the button counts the shown ones ("11 of 14"), the line beside it names the hidden
ones with "Show all", "Hide all" stands beside it while any is shown, and the Repositories table,
which keeps every repository, marks them hidden.
A link to an item in a hidden repository still opens it, and a repository's own pages hide
nothing. A row
whose item file changed since the visit before, a run of page views under an hour apart in this
browser, says so, and whether its question or options changed; each fold counts such rows. An
opened question shows its first paragraph, the item's own images, its options, each with its key
where that is a letter (`b`, `c2`) as the item's text names it, and its buttons before the rest of
its text. A row a link opens starts below the "Copy answers" bar, which on a
phone keeps one line beside its button. A page left open over an hour says so.

When a build fails or a repository cannot be read at its HEAD, every page says so above its
content, keeps the last pages it built, and the hub tries again a minute later, or once a
repository changes. A fetch that moves no ref builds nothing: the page prints the new fetch time
as it is served. A
relative link from one doc to another opens that doc's page.

In an item's text a path under `docs/agent-work/` links into the repository named right
before it (``website `docs/agent-work/…` ``) or after it (`` `…` in website ``), else into the
item's own, and stays text where that repository holds no such file. A Markdown link relative to
the item file resolves from `docs/agent-work/items/`.

## Answers

Answers to decisions stay in the browser as they are typed, across reloads and with no prompt on
leaving, until "Copy answers", on every page that lists questions, puts them on the clipboard under
the line `Answers from the admin pages:`, one line each in the page's order, then the answers to
items not on the page: `repo:id: stance, choice, note`, each part left out where it is empty. The
choice is each picked key with its label as answered, `a (Label A), b (Label B)`, a bare key where
the answer kept no label and its row is not on the page, or `done` where the row was marked done and
no option picked; the note's runs of white space become one space. A copy holds the answers not
copied yet, and all of them again once none is new. An answer keeps the item's title and options it
answered: where they changed since, its row shows the pick as given and asks for a new answer, and
its line ends `; answered <time>, before the question or its options changed`, which the agent
checks against the item before it acts. An assumption is answered "Agree" or "Veto", the stance that
leads its line: `repo:id: veto, b (Label B), note`. "Decide later" puts a question off: it stays out
of the copy, and the next visit, a page view more than an hour after the last, asks it again, with a
note written beside it as its answer.

## What a page may load

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

## Catalog entries

A repository gets a Catalog entry when an `astro.config.*` at its root or one folder down loads
Astrobook or scaffolding's catalog preset, at `http://127.0.0.1:<port>` from that config: at
`/catalog/` for the preset (v2 or later), which answers there whether its catalog is the site's
home or sits under `/catalog/`, and at `<base><subpath>` for Astrobook. The page names the package
script that starts it (`catalog` where the preset's repository has one) and says whether it is
running now.
`admin.designSystem` overrides it.

## Configuration

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

A product's optional `description` leads its page. An `href` without a scheme is a path in the repository: the hub serves it from HEAD, and a file it
links under `node_modules/` from the installed package.
