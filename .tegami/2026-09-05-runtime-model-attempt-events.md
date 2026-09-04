---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Surface provider call attempts as runtime events

Emit a new ephemeral `model-attempt` agent event for every physical provider
call in a model step, including the retries the AI SDK previously performed
invisibly beneath `streamText`. Each event carries the step's `attemptId`, a
1-based `attempt` counter, and a start/end phase whose end reports the outcome
plus the normalized provider error when the runtime can observe it. Hosts that
already consume stream events receive these automatically; the committed
`model-usage` event remains the durable per-step record.
