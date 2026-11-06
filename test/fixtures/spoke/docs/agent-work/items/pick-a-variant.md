---
kind: decision
status: open
priority: 1
area: product
owner: Alex
recommended: a
options:
  - key: a
    label: Variant A
    detail: The calmer one.
    score: 8.4
    noise: 0.5
  - key: b
    label: Variant B
    score: 6.1
images:
  a: docs/agent-work/2026-01-15-sample-topic/variant-a.svg
  b:
    - src: variant-b.svg
      caption: light, 600 px
    - src: variant-b-dark.svg
      caption: dark, 600 px
---

# Which variant ships?

Both variants were scored blind. Report: docs/agent-work/2026-01-15-sample-topic.md.

- Variant A keeps the current layout.
- Variant B moves the menu to the top.
