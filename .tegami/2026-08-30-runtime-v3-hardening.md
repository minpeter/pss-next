---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Fence durable run ownership

Unify claim semantics across execution stores and reject run transitions or
checkpoint writes from stale lease owners.
