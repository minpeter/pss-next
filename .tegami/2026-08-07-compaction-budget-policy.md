---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Turn compaction into budget-owning policy objects

`createAgent` accepts a compaction policy object carrying the context budget it compacts toward; the model-step context gate calls the policy's `maxInputTokens()` before every model request, so custom compaction and the gate can no longer drift apart. `speculativeCompaction` returns such a policy, and `contextGateForCompaction`/`estimatorForCompaction`/`DEFAULT_AGENT_MAX_INPUT_TOKENS` are removed: a bare `AgentCompaction` function now runs with the local gate off (provider-overflow-reactive compaction only) instead of a silent 128K fallback budget. A policy without `compact` is a budget-only source; pair it with `onOverflow: "error"` to fail over-budget turns without rewriting history.
