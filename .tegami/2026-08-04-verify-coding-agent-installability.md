---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Verify coding-agent dependencies before publishing

Pack the coding agent and resolve its registry dependencies before Tegami can publish, preventing releases that depend on missing npm packages.
