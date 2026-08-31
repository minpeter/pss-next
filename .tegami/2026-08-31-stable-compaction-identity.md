---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Reuse speculative summaries across thread reconstruction

Process-local speculative candidates now survive same-Agent thread reconstruction in a bounded cache while remaining isolated when a compaction policy is shared by multiple Agents.
