---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Preserve falsy buffered turn errors as rejections

Separate successful and failed buffered turn closure so every JavaScript falsy value remains observable as an iterator rejection.
