---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Bound automatic compaction blocking

Automatic compaction now keeps one bounded speculative replacement, applies a
shared 15-second deadline to each compaction episode, surfaces typed overflow
timeouts, and reports privacy-bounded lifecycle diagnostics.
