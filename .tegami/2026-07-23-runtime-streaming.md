---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Unify the model step on one streaming part sequence

`turn.events()` now emits five ephemeral delta kinds between `step-start` and
a step's committed events: `assistant-output-delta { text }`,
`assistant-reasoning-delta { text }`,
`tool-call-input-start { toolCallId, toolName }`,
`tool-call-input-delta { toolCallId, inputTextDelta }`, and
`tool-call-input-end { toolCallId }`. Models with `doStream` stream natively.
`doGenerate`-only models synthesize the same part sequence from the committed
result (one delta per committed text or reasoning block, one start/delta/end
triple per tool call, in committed order), so consumers see exactly one event
shape regardless of model capability. `isLanguageModelObject` now accepts
doGenerate-only models.

Deltas are never persisted: a recording-boundary guard keeps them out of
`thread.events()` durable replay and event logs, and they bypass plugins
entirely. The committed `assistant-output`, `assistant-reasoning`, and
`tool-call` events remain the durable per-step record. Both "deltas then
committed" and "just committed" are valid sequences, so renderers dedupe
against the committed event. On a mid-stream abort a prefix of deltas can
remain in the in-memory stream before `turn-abort`; consumers must tolerate
deltas without committed output.

`streamAgentEventTypes`, the `StreamAgentEvent` type, and `isStreamAgentEvent`
are exported from the package root. The delta kinds are their own class: not
visible, lifecycle, tool, or telemetry events.
