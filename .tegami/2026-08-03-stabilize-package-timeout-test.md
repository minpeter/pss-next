---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Stabilize package timeout testing

Give spawned test processes enough startup time on loaded CI runners while preserving coverage of forced descendant termination.
