---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Keep private workspaces out of release planning

Exclude every private and experimental workspace from Tegami's dependency graph so benchmark dependency bumps cannot indefinitely block coding-agent publication.
