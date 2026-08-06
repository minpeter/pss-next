---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Gate dependency vulnerabilities in CI

Refresh vulnerable transitive resolutions and run the reproducible moderate-level
pnpm audit during CI validation without changing published package behavior.
