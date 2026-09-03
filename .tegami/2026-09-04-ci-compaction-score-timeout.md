---
packages:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Raise the production-overlap CLI test budget for CI

The compaction-score CLI artifact test spawns real CLI subprocesses whose
runtime exceeds the 30s budget on loaded CI runners; the budget is now 120s.
