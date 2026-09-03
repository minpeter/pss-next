---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Reuse speculative summaries across thread reconstruction

Process-local speculative candidates now survive same-Agent thread reconstruction in a bounded cache while remaining isolated when a compaction policy is shared by multiple Agents.
