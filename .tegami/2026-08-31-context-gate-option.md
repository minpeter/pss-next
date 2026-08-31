---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Configure the context gate independently

`createAgent` now accepts an explicit `contextGate` that takes whole-object precedence over compaction budget metadata without changing speculative compaction thresholds.
