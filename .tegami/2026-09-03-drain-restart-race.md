---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Keep restarted drain turns successful

Wait for a requested queue-drain restart before settling joined callers, so a
queued turn cannot receive a failure and then execute anyway.
