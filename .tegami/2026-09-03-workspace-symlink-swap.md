---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Re-verify workspace containment at mutation time

Workspace mutations re-canonicalize the nearest existing ancestor immediately
before writing or deleting, so an intermediate directory swapped for an
escaping symlink between resolution and mutation now fails closed instead of
writing or deleting outside the workspace.
