---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Fail closed on missing checkpoints

Checkpoint adapters now surface checkpoint corruption when authoritative run metadata references a missing checkpoint, preventing resume from silently restarting at step one.
