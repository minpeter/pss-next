---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Keep shrinking output cards from lifting the composer

Keep the composer steady when HOT output shrinks by reserving blank rows at the transcript tail. Completed blocks contain only actual content, and subsequent output consumes the shared reserve. Width changes recompute it; canonical messages and files remain unchanged.
