---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Harden thread and session lifecycle ownership

Retain the authoritative thread handle when deletion fails, and remove the
destructive behavior of the deprecated `new-session` extension action. Existing
extensions remain source-compatible, but hosts now ignore that action; use the
built-in `/new` or `/clear` command for guarded session replacement.
