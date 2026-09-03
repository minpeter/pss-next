---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Enforce the script size ceiling on every script file

The 250 pure-LOC ceiling now applies to all `scripts/**/*.mjs|mts` sources
instead of a fifteen-file allowlist, and the public API snapshot collector is
split into `runtime-public-api-collect.mjs` and
`runtime-public-api-snapshot.mjs` so both stay under the ceiling.
