---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Add speculative background compaction

Replace the legacy auto-compaction options with a callable compaction policy
and add a speculative strategy that prepares summaries before promotion.
Preserve overflow recovery, hook interception, and stale-commit protection.
