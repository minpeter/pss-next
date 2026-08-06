---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

Prevent idempotent notification retries from rescheduling terminal runs and fail safely when deduplicated notification records are missing or inconsistent.
