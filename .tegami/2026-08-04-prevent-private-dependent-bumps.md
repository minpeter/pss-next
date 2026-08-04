---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Prevent private dependent version bumps

Disable Tegami dependency propagation into excluded workspaces so coding-agent releases cannot mutate private benchmark versions or delay publication.
