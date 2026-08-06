---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Add session TUI compaction parity

Add explicit `/compact` and Pi-compatible `/session` commands to the interactive TUI, with runtime-owned durable context compaction and documented session UX.
