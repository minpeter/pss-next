---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Harden thread and session lifecycle ownership

Retain the authoritative thread handle when deletion fails, and remove the
destructive behavior of the deprecated `new-session` extension action. Existing
extensions remain source-compatible, but hosts now ignore that action; use the
built-in `/new` or `/clear` command for guarded session replacement.
