---
slug: streaming-support
status: drafting
intent: clear
review_required: false
pending-action: write .omo/plans/streaming-support.md
approach: <fill: the approach you intend to plan>
---

# Draft: streaming-support

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

## Findings (cited - path:lines)

## Decisions (with rationale)

## Scope IN

## Scope OUT (Must NOT have)

## Open questions

## Approval gate
status: drafting
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

---

## Intent + classification
- intent: clear
- review_required: false
- classification: Architecture (cross-cutting core change + public event contract + 2 apps)
- slug: streaming-support

## Components (topology lock)
1. core-stream-engine — model-step.ts generateText→streamText, delta callback, identical final ModelStepResult (packages/runtime/src/llm)
2. event-protocol — new ephemeral delta kinds in AgentEvent union + stream classifier (thread/protocol/events.ts)
3. loop-plumbing — delta channel through runAgentLoop/step-output/queued-input-processor + ephemeral bypass in emitTurnEvent (agent/loop, thread/runtime)
4. coding-agent-surfaces — TUI adapter per-token deltas; exec NDJSON passthrough (apps/coding-agent)
5. contracts-docs-examples — root-api-events/channel-api tests, READMEs, examples, changesets
6. worker-agent-live — OUT OF SCOPE (default; net-new live path, Telegram can't use token streams)

## Key findings (evidence)
- generateText at packages/runtime/src/llm/model-step.ts:82 is the only model call; no streaming anywhere.
- AgentEvent union: thread/protocol/events.ts:81-109; classifiers at :113-136.
- Durability is DEFAULT-ON for every event via emitTurnEvent recordEvent (turn-events.ts:54-60, thread-event-log.ts:11-16) → deltas need explicit ephemeral bypass.
- File store append is O(whole-file) per append (event-store.ts:162-172); SQLite one row+seq per event → deltas must NOT persist.
- Resume boundary = whole model step (execution/resume/checkpoints.ts:50-66); crash mid-step loses the step today; ephemeral deltas change nothing.
- BufferedAgentTurn.emit is non-blocking + structuredClone (protocol/turn.ts:47-53); emitBoundary acks drive the turn → deltas use plain emit (no per-token backpressure).
- TUI already has incremental delta rendering (tui/stream-handlers.ts:144-161, stream-views.ts:31-95); only adapter agent-event-stream.ts:80-84 wraps whole text as one delta.
- pss exec passes every event through as NDJSON (exec.ts:151-154) → deltas surface free; finalText accumulates assistant-output only (exec.ts:75-77) → no double count.
- worker-agent: drainAgentTurn collects-then-delivers (platform/cloudflare/turn-drain.ts:19-31); /session/events SSE replays DURABLE events w/ post-turn wake (session-events.ts:90-122) → no live token path; net-new work.
- channel projectChannelAssistantDelivery projects only assistant-output (channel/index.ts:16-26) → delta kinds must project to undefined (channel-api.test.ts pins this).
- root-api.test.ts:84-86 forbids run-stream helpers at root → no turn.stream() API at root.
- AI SDK v7.0.34 streamText (node_modules/.pnpm/ai@7.0.34_zod@4.4.3/node_modules/ai/dist/index.d.ts):
  - fullStream: AsyncIterableStream<TextStreamPart> (:2715, :2917) with text-delta{text,id}(:2797), reasoning-delta{text,id}(:2823), text-start/end, reasoning-start/end, start-step, finish-step, finish, abort, error, raw, tool-input-start/delta/end.
  - Result promises: responseMessages(:2685), usage, totalUsage(:2644), finishReason, steps, finalStep(:2663), response; consumeStream()(:2743).
  - streamText options parity with generateText confirmed (:3356): instructions, messages, activeTools, toolChoice, toolOrder, tools, abortSignal all present.

## Adopted defaults (no user question)
- Deltas NEVER persisted/recorded; ephemeral bypass in emitTurnEvent; crash semantics unchanged.
- Final assistant-output / assistant-reasoning events still emitted from responseMessages (canonical durable record; existing consumers unchanged).
- Tool-input deltas (tool-input-start/delta/end) NOT forwarded in v1 — text + reasoning only; additive later.
- TDD RED→GREEN via vitest + MockLanguageModelV4 doStream; mutation-proof assertions; contracts updated.
- Execution in git worktree from main HEAD 18f9bde (uncommitted hook changes on main NOT included; possible later conflict surface: agent.ts/options.ts).

## Open forks (awaiting user)
- F1 scope: worker-agent live streaming? rec: NO (core + coding-agent only)
- F2 event shape: rec: new ephemeral kinds assistant-output-delta/assistant-reasoning-delta + isStreamAgentEvent classifier
- F3 default-on vs opt-in: rec: default-on, no config surface

## Approval gate
status: exploring-complete, forks-presented
pending-action: present brief, wait for explicit okay
