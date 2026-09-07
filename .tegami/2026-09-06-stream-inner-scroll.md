---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Bounded streaming text bodies

Streaming assistant text, reasoning, and tool text bodies follow the latest eight wrapped terminal rows. Completed assistant text expands fully before becoming immutable; full source content, headers, the composer, and atomic graphical output are preserved.
