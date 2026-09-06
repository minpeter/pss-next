---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Reuse shrinking output's reserved space at the transcript tail

Keep synthetic shrink padding separate from immutable completed output. Following blocks and their normal separators consume the shared trailing reserve before transcript height grows, without removing genuine blank lines, Markdown spacing or graphics reserved rows. Width changes recompute the reserve and transcript resets clear it.
