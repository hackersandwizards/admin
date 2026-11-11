# Item files

The item format, its fields and how agents use items: the `parallel-session` skill,
[`.claude/skills/parallel-session/SKILL.md`](../.claude/skills/parallel-session/SKILL.md). This
file adds what `admin-check` enforces and how the hub treats item files. It does not check the
skill's conventions, such as JPEG images at most 1600 px wide.

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
area: product # optional, free text
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
  fields and a top-level field written twice are defects.
- An open decision has at least two options. A request to look at something is `kind: review`.
- `recommended` and every `images` key name an option; several recommended need `multiple: true`.
  `images` may instead be a list: images of the item as a whole, shown under its text.
- An image is a file name in the item's folder, or `{src, caption}`; a value with a slash is read
  from the repository root, as items written before the folder did. Every image exists, and an
  image folder whose item is gone is a defect.
- The file name is the id: lower-case letters, digits and `-`. `docs/agent-work/items/` holds only
  `<id>.md` files and `<id>/` image folders, and the body starts with `# <title>`.
- An option's `key` is one word, without a comma or space, and no two options share one; `multiple`
  is `true` or `false`. `label`, `detail`, `area`, `owner`,
  `assumption`, `decision`, `by`, `quote` and `evidence` are text.
- `score` and `noise` are numbers; `noise` needs a `score`.
- An `assumed` item states `assumption` or `recommended`. A `decided` item states `decision` and
  `by`, and may quote the person in `quote`.
- Work and goals are only ever `open`.
- `due` is a calendar day as an ISO date, `order` a number. `order` and `evidence` are optional.
- A table, such as scores per criterion, goes in the body as Markdown.
- No `GOAL.md` and no file under `docs/tracking/` remains.
