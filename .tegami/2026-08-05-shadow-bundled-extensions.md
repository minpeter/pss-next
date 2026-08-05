---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Shadow bundled extensions with installed ones

An installed extension whose id matches a bundled default (latex, mermaid, web) now replaces the bundled copy instead of crashing host creation with a duplicate-id error. The three built-in extension packages are publishable, so `pss extension install`/`update` can deliver them between coding-agent releases.
