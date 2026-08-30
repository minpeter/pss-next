---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Fence durable run ownership

Unify claim semantics across execution stores and reject run transitions or
checkpoint writes from stale lease owners.
