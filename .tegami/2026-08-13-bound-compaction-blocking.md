---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
  npm:@minpeter/pss-runtime:
    type: patch
---

## Bound automatic compaction blocking

Enforce one deadline at the serialized store boundary, preserve compatible
conflict tails, coalesce retries, and reuse only source-stable candidates.
Bound diagnostics and add causal benchmark evidence.
