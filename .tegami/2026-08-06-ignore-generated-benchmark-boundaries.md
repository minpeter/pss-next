---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Keep generated benchmarks out of boundary checks

Exclude the Next.js benchmark workspace from the CI boundary scan so ignored,
large generated result trees do not consume boundary-check time and memory.
