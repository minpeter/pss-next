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
counter, and a start/end phase. The end event reports the outcome, duration of
the provider call excluding retry backoff, and the normalized provider error
for failed attempts even when the AI SDK subsequently retries them. Hosts that
already consume stream events receive these automatically; the committed
`model-usage` event remains the durable per-step record.

Extensions can subscribe to the new event through `pss.on("model-attempt", ...)`, which
previously threw for this event id, and the coding agent forwards it on its live NDJSON
and TUI event streams. The event is live-only and never lands in durable history or
headless result payloads.
