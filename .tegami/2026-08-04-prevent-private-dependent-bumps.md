---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Prevent private dependent version bumps

Disable Tegami dependency propagation into excluded workspaces so coding-agent releases cannot mutate private benchmark versions or delay publication.
