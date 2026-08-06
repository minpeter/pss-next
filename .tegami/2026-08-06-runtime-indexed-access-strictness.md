---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Strengthen runtime indexed access checks

Type-check shipped runtime source with `noUncheckedIndexedAccess` and document the staged exact-optional migration baseline without diagnostic suppressions.
