---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Reorganize Durable Object platforms

Move shared Durable Object storage, SQLite, and scheduled-work primitives into
a neutral platform core, with Cloudflare and Celld as sibling implementations.
Replace the former Cloudflare and Celld package paths with the new hierarchy.
