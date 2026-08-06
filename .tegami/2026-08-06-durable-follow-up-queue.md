---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Add durable followUp turns with recovery

Add durable `followUp` turns with recovery and distinct metadata. FIFO one-at-a-time execution applies within one process/isolate to handles sharing the exact store wrapper.
