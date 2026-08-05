---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Require explicit approval before releasing

Record that the automated Version Packages pull request, which publishes
to npm on merge, is merged only when the user explicitly asks to release.
