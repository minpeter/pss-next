---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Isolate detached compaction summaries

Prevent summaries produced from transformed or unknown model context from becoming reusable by later standard-context compaction episodes.
