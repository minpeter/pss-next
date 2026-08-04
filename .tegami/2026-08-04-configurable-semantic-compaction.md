---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Make compaction summary policy configurable

Allow compaction policies to supply summary instructions and omit raw deterministic tool evidence, while preventing the default handoff from serializing tool-call protocol as text.
