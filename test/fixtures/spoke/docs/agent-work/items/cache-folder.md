---
kind: decision
status: assumed
priority: 3
owner: Alex
assumption: The build writes to node_modules/.cache, so no repo needs a new ignore line.
---

# Where the build writes its pages

The build checked both:

- [x] no repository ignores the folder yet
- [ ] a cache outside the checkout
