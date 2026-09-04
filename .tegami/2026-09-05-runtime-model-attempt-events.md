---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Surface provider call attempts as runtime events

Emit an ephemeral `model-attempt` agent event for every physical provider call
in a model step, including retries performed beneath both `streamText` and
`generateText`. Each event carries the step's `attemptId`, a 1-based `attempt`
counter, and a start/end phase. The end event reports the outcome and, when
measurable, the duration of that provider call excluding retry backoff. Failed
attempts also report a normalized provider error when it can be classified,
including failures that the AI SDK subsequently retries. Hosts that already
consume stream events receive these automatically; the committed `model-usage`
event remains the durable successful-step record.

Extensions can subscribe to the new event through
`pss.on("model-attempt", ...)`, which previously threw for this event id, and
headless coding-agent runs forward it on their live NDJSON stream. The event is
live-only and never lands in durable history or headless result payloads.
