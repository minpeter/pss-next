---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Gate dependency vulnerabilities in CI

Refresh vulnerable transitive resolutions and query the npm advisory service for
moderate-or-higher findings during CI validation without changing published
package behavior.
