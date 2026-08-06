---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Harden notification retry handling

Prevent idempotent notification retries from rescheduling terminal runs and fail safely when deduplicated notification records are missing or inconsistent.
