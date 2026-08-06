---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

Validate published package metadata and packed-tarball imports in the release gate, and ship a stable `pss-eval` bin wrapper that avoids missing-bin install warnings before builds.
