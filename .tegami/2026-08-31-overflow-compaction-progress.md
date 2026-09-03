---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Advance overflow compaction past tool-heavy turns

When backward range selection collapses inside a tool exchange, compaction now advances to the next valid boundary without weakening tool-exchange integrity.
