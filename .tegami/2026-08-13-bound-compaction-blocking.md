---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Bound automatic compaction blocking

Bound compaction preparation with one shared deadline, safely reuse prepared
summaries across retries and committed prefixes, and report privacy-bounded
timeouts with sanitized overflow context.
