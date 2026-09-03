---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Support web and edge runtime timers

Guard detached compaction timer `unref` calls so numeric web timer handles do not crash summary startup or cleanup.
