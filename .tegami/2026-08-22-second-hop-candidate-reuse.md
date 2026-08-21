---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Reuse prepared compaction after a committed prefix

Speculative compaction now reuses a still-fitting prepared candidate after a
prefix compaction is already committed, as long as `modelContext` is the
standard compacted projection. Transformed context and over-budget wrapper-plus-
tail still fail closed and summarize again.
