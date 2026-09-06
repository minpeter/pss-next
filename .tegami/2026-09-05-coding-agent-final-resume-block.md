---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Reliable session resume output on exit

Reuse the composer separator row for the current session's resume command after bounded turn finalization and runtime cleanup, without an extra rule or blank line. Keep shutdown failures above the final separator and command, including on narrow streaming exits.
