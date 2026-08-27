---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Bound automatic compaction blocking

Enforce one deadline at the serialized store boundary, preserve compatible
conflict tails, coalesce retries, and reuse only source-stable candidates.
Bound diagnostics and add causal benchmark evidence.
