---
kind: decision
status: assumed
topic: 2026-01-15-sample-topic
priority: 3
owner: Alex
needs: [pick-a-variant]
assumption: The build writes to node_modules/.cache, so no repo needs a new ignore line.
---

# Where the build writes its pages

The build checked both:

- [x] no repository ignores the folder yet
- [ ] a cache outside the checkout
