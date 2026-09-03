---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Fail closed on missing checkpoints

Checkpoint adapters now surface checkpoint corruption when authoritative run metadata references a missing checkpoint, preventing resume from silently restarting at step one.
