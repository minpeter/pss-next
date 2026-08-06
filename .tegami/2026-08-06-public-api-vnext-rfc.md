---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Document and guard Public API vNext

Define the vNext runtime API direction and add a CI snapshot gate for every
published runtime entrypoint without changing shipped behavior.
