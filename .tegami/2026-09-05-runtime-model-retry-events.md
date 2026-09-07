---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Expose authoritative provider retry scheduling

Add live-only `model-retry` scheduled/started/stopped events with delay, deadline,
remaining retries, and cancellation or terminal decisions. Runtime-owned provider
retries preserve the SDK baseline; extensions and NDJSON receive the events without persisting them.
