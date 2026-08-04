---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Harden thread storage lifecycle

Make Durable Object thread schema migration idempotent and add aggregate thread deletion that removes runtime-owned snapshots, events, runs, notifications, scheduled work, and payload chunks.
