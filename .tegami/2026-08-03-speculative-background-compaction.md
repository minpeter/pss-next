---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Add speculative background compaction

Replace the legacy auto-compaction options with a callable compaction policy
and add a speculative strategy that prepares summaries before promotion.
Preserve overflow recovery, hook interception, and stale-commit protection.
