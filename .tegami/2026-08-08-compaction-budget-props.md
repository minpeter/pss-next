---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Carry the compaction budget as function properties

The `compaction` option is a single callable type again: `AgentCompaction` gains optional budget properties (`maxInputTokens`, `estimateTokens`, `bufferTokens`, `onOverflow`), and when `maxInputTokens` is present the runtime hands the function itself to the model-step context gate, which calls it before every model request. `speculativeCompaction` returns the callable with its budget attached; `AgentCompactionPolicy` and the interim policy-object form from 0.3.0-next.11 are removed. Bare functions without budget properties keep the local gate off.
