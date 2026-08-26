---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Bound runtime test workers

Limit runtime Vitest concurrency so cold imports remain within their test
deadlines when the full workspace test suite fans out across packages.
