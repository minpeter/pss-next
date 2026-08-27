---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Prepare the release sandbox

Install the task-validator sandbox in the release workflow so its pre-publish
test gate exercises the same isolated environment as CI.
