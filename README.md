# @hackersandwizards/admin

The admin engine: `admin-check` checks a repository's item files (its decisions, reviews, work and
goals in `docs/agent-work/items/`), and `admin-serve` runs the hub, one local page across every
repository under `~/dev`. It holds code only. Every item, report and image stays in the repository
it belongs to.

| You want                                                 | Go to                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| the check in your repository's gate                      | [Install](#install) and [Check your items](#check-your-items)                                                                            |
| to write an item file                                    | [docs/items.md](docs/items.md): where it goes, every field, what the check rejects                                                       |
| to answer the open decisions                             | [Run the hub](#run-the-hub), then [Answers](docs/hub.md#answers)                                                                         |
| what the hub shows, what it loads and what you configure | [docs/hub.md](docs/hub.md), with [Configuration](docs/hub.md#configuration) and [What a page may load](docs/hub.md#what-a-page-may-load) |
| every page and component, on invented data               | the catalog, linked in the hub's rail: [docs/hub.md](docs/hub.md#addresses)                                                              |
| to change the engine                                     | [Work on the package](#work-on-the-package)                                                                                              |

## Install

A repository adds the package as a dev dependency pinned to a tag. The repository is public, so
the install needs no GitHub login:

```sh
bun add -d "git+https://github.com/hackersandwizards/admin.git#v<version>"
```

`<version>` is the newest of the
[repository's tags](https://github.com/hackersandwizards/admin/tags).

Requirements: bun 1.4 or newer, and Git on the `PATH`: every command reads repositories through it.
`admin-check` needs nothing else; `admin-serve` needs brand, Astro and Tailwind beside it, as
[docs/hub.md](docs/hub.md#run-it) lists.

## Commands

- `admin-check [<repo>...]` checks the item files in the working tree, default the current directory. Exit 1 on a defect.
- `admin-serve` serves the hub: [docs/hub.md](docs/hub.md#run-it).

## Check your items

`admin-check` belongs in every repository's gate. With scaffolding's gate, `bun run check` runs it
as the shared `admin` step, with nothing to configure, and refuses to run while the package is not
pinned; the pre-commit hook runs it over the staged items. Run it alone with `bun run admin-check`:
it prints `ok: <n> item(s) in <repo>`, or each defect and exit 1. What it enforces:
[docs/items.md](docs/items.md). The format and how agents keep items: the
[parallel-session skill](.claude/skills/parallel-session/SKILL.md).

## Run the hub

Clone this repository, run `bun install`, then `bun run dev`: it runs `admin-serve`, the one hub.
Open `http://admin.localhost:4329`. Which repositories it shows and their addresses:
[docs/hub.md](docs/hub.md#addresses).

"Copy answers" on the hub puts your answers on the clipboard. Paste them into an agent session in
one of the repositories: the agent writes each answer for that repository into its item and hands the
others, quoted, to a session in theirs, as the skill describes. The
hub's addresses, pages, answers and the `admin` settings in `package.json` or `docs/agent-work/admin.json`: [docs/hub.md](docs/hub.md).

## Work on the package

- `bun install` installs and points the git hooks at `.githooks/`
- `bun run check` runs the gate: scaffolding's shared steps, then the steps in `package.json`'s `scaffolding.check`
- `bun run dev` runs the hub on `http://admin.localhost:4329`
- `bun run catalog` serves the catalog live at `http://127.0.0.1:4332/`; on the hub it is `/catalog/`

A release is a tag `v<version>` matching `package.json`. The rules for changing the engine:
[CLAUDE.md](CLAUDE.md).

## License

[PolyForm Strict 1.0.0](LICENSE): free for noncommercial and personal use, no redistribution or
derived works, plus a permission for trainers hackers&wizards commissions. The name hackers&wizards
and its logos are not licensed.
