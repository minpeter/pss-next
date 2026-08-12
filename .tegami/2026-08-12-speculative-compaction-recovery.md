---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Improve speculative compaction recovery

Reuse prepared summaries when their complete remaining context still fits, and
retry one failed background summary before the next user request.
