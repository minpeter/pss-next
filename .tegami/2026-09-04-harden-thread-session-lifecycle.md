---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Harden thread and session lifecycle ownership

Retain the authoritative thread handle when deletion fails, and remove the
legacy extension action that could destructively clear the active session.
