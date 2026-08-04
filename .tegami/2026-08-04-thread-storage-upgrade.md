---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Harden thread storage lifecycle

Make Durable Object thread schema migration idempotent and add aggregate thread deletion that removes runtime-owned snapshots, events, runs, notifications, scheduled work, and payload chunks.
