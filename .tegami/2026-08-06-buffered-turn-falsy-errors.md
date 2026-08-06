---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Preserve falsy buffered turn errors as rejections

Separate successful and failed buffered turn closure so every JavaScript falsy value remains observable as an iterator rejection.
