---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Configure the context gate independently

`createAgent` now accepts an explicit `contextGate` that takes whole-object precedence over compaction budget metadata without changing speculative compaction thresholds.
