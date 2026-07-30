# streaming-support - Work Plan

## TL;DR (For humans)
**What you'll get:** Core streaming with live text, reasoning, and tool-input
deltas; non-streaming models use the same event path through synthesized
deltas. The coding-agent TUI renders incrementally and exec emits live NDJSON
without bloating its final result.

**Why this approach:** One normalized part stream prevents streaming and
non-streaming behavior from diverging. Deltas are explicitly ephemeral while
the existing complete events remain the durable compatibility boundary.

**What it will NOT do:** It does not persist deltas, route them through plugins,
or add live Telegram/worker-agent delivery. It adds no second stream API or
opt-in configuration.

**Effort:** Large
**Risk:** Medium - public event expansion and abort/durability ordering cross
the core loop, storage boundary, and TUI/CLI consumers.
**Decisions to sanity-check:** Default-on deltas, plugin bypass, and worker-agent
live streaming remaining out of scope.

Your next move: review or merge the completed worktree branch. Full execution
detail follows below.

---

> TL;DR (machine): Large/medium-risk core event-stream feature; unified native/synthesized deltas, ephemeral durability boundary, TUI/exec consumers, contracts/docs/release notes.

## Scope
### Must have
- ONE unified internal model-step path in `@minpeter/pss-runtime`: an async part-stream whose source is `streamText(...).stream` when the model has `doStream`, or a `generateText(...)` adapter that synthesizes the same part sequence when it does not. Both model kinds produce identical event shapes downstream.
- Five new EPHEMERAL event kinds on `AgentEvent` + `streamAgentEventTypes` classifier + `StreamAgentEvent` type + `isStreamAgentEvent` guard, exported from the package root:
  - `assistant-output-delta { text: string }`
  - `assistant-reasoning-delta { text: string }`
  - `tool-call-input-start { toolCallId: string; toolName: string }`
  - `tool-call-input-delta { toolCallId: string; inputTextDelta: string }`
  - `tool-call-input-end { toolCallId: string }`
- Delta plumbing: deltas flow live through `turn.events()` between `step-start` and the committed `assistant-output`/`assistant-reasoning`, via a dedicated ephemeral branch (plain `run.emit`, NO durable record, NO plugin interception, NO boundary ack).
- Streaming and non-streaming models BOTH always emit deltas (non-streaming emits one synthesized delta per committed text/reasoning) so consumers have exactly one event shape to handle.
- Final committed events (`assistant-output`, `assistant-reasoning`, `tool-call`, `tool-result`, `model-usage`) remain emitted from `responseMessages` exactly as today — durable record, replay, and channel delivery unchanged.
- `doGenerate`-only models become accepted (relax the `doStream` requirement in `isLanguageModelObject`).
- TUI renders token deltas incrementally; `pss exec` streams delta events as NDJSON lines but excludes them from the accumulated `result.events` array.
- Examples' drain patterns print deltas live without default-branch log spam; READMEs document the new kinds; tegami release letters for both packages.
### Must NOT have (guardrails, anti-slop, scope boundaries)
- NO persistence of delta events: they never enter `DurableThreadEventBuffer`, never appear in `thread.events()` durable replay, never in file/SQLite event logs.
- NO worker-agent product changes (no live SSE, no Telegram delta delivery; its
  OpenAI test fixture may be updated to speak the now-used streaming protocol).
- NO plugin hooks for deltas (no interception, no transform, no `observeAgentEvent` per delta) — plugins see committed events only.
- NO new `turn.stream()` / run-stream helper API and no new package subpath; `root-api.test.ts` export-surface rules stay satisfied.
- NO new opt-in config surface: streaming is the single unified path, always on.
- NO per-token backpressure: deltas use plain `run.emit` (non-blocking), never `emitBoundary`.
- NO changes to committed event ordering, durability flush boundaries, resume/checkpoint semantics, or `modelMessageToAgentEvents`.
- NO double-render in consumers: committed `assistant-output` text must not be rendered after deltas for the same step were already rendered.
- NO use of deprecated AI SDK members (`totalUsage`; `fullStream` if marked @deprecated in the installed types) — `pnpm lint` must stay clean.
- NO reliance on the stream throwing on abort: the AI SDK closes gracefully, abort detection is explicit.

### Invariants & accepted risks (documented behavior, not bugs)
- Deltas never persist: control-flow exclusion in `emitTurnEvent` PLUS a `recordDurableThreadEvent` guard that rejects stream kinds (defense in depth; storage validation at event-log-schemas.ts:75-77 is type-string-only and would otherwise accept them).
- A mid-stream abort leaves a PREFIX of deltas in the in-memory `turn.events()` stream before `turn-abort` (deltas are not recalled); consumers must tolerate deltas-without-committed-output as a terminal state. Durable replay contains none of it.
- Both "deltas then committed" and "just committed" are VALID consumer sequences for text and for tool calls (providers without tool-input streaming emit no `tool-call-input-*`; the doGenerate adapter always synthesizes them).
- `doStream` deltas arrive in provider stream order; synthesized doGenerate deltas arrive in committed order (reasoning first). Consumers must not assume cross-capability ordering parity.
- Delta kinds classify as `ControlAgentEvent` by complement (they are intentionally not `VisibleAgentEvent`); do not "fix" this — visible membership would break the channel projector contract.
- Accepted costs: one `structuredClone` per delta in `BufferedAgentTurn.emit` (turn.ts:46-49); the in-memory delta buffer is bounded only by one step's deltas (boundary acks do not apply to deltas). Escape hatches (unowned emit, delta coalescing) are out of scope.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD (RED→GREEN per todo) with vitest; mock `LanguageModelV4` fixtures drive `doStream`/`doGenerate` (`packages/runtime/src/testing/mock-language-model-v4-test-utils.ts` extended with `doStream` support). Mutation discipline: each new assertion must fail when the seam it names is broken.
- Characterization first: `pnpm --filter @minpeter/pss-runtime test` baseline captured on the untouched worktree (todo 1); suites pinning committed events must stay green throughout.
- Evidence: `.omo/evidence/streaming-support/task-<N>-<slug>.<ext>` (RED/GREEN test output, NDJSON artifacts, demo transcripts) plus cleanup receipt per artifact.
- Real-surface proof: `pss exec` NDJSON stdout (auxiliary surface, first-class for CLI work) + a scripted-model demo capturing delta arrival order with monotonic timestamps.
- Final gates: `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint` at the worktree root, one run each, immediately before handoff.

## Execution strategy
Orchestrator delegates every implementation todo to a worker subagent (start-work discipline); orchestrator runs verification, adversarial probes, evidence capture, and checkbox gates. All work in the task-owned worktree `../../pss-runtime-streaming` (branch `feat/streaming-support`, base `18f9bde`).
### Parallel execution waves
- Wave 0: todo 1 (worktree + baseline)
- Wave 1: todos 2, 4 in parallel (disjoint files: `src/llm` vs `src/thread/protocol`)
- Wave 2: todo 3 (needs 2's stream source + 4's event types)
- Wave 3: todo 5 (runtime plumbing, needs 3+4)
- Wave 4: todos 6, 7 in parallel (TUI vs exec+examples, disjoint)
- Wave 5: todos 8, 9 in parallel (contract pins vs docs/letters)
- Final: F1-F4 in parallel

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2-9 | — |
| 2 | 1 | 3 | 4 |
| 4 | 1 | 3, 5, 8 | 2 |
| 3 | 2, 4 | 5 | — |
| 5 | 3, 4 | 6, 7, 8 | — |
| 6 | 5 | 9 | 7 |
| 7 | 5 | 9 | 6 |
| 8 | 4, 5 | F-wave | 9 |
| 9 | 6, 7 | F-wave | 8 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Create task worktree, install, capture green baseline
  What to do: `git worktree add /home/minpeter/github.com/minpeter/pss-runtime-streaming -b feat/streaming-support 18f9bde` from the main repo; `pnpm install` inside it; run the full baseline. Must NOT: commit anything; touch the main worktree.
  Parallelization: Wave 0 | Blocked by: — | Blocks: 2-9
  References: repo root `/home/minpeter/github.com/minpeter/pss-runtime`; package.json scripts (`test`, `typecheck`, `build`, `lint`).
  Acceptance criteria: `git -C /home/minpeter/github.com/minpeter/pss-runtime worktree list` shows the new worktree on branch `feat/streaming-support`; `cd /home/minpeter/github.com/minpeter/pss-runtime-streaming && pnpm --filter @minpeter/pss-runtime test` exits 0; baseline pass/fail counts recorded.
  QA scenarios: happy = baseline suite green (Evidence `.omo/evidence/streaming-support/task-1-baseline.txt`); failure = if install fails, capture output and stop.
  Commit: N
- [x] 2. Unified model-step stream source with doGenerate fallback
  What to do: RED first — extend `packages/runtime/src/testing/mock-language-model-v4-test-utils.ts` with `doStream` fixtures (scripted stream parts incl. `text-delta`, `reasoning-delta`, `tool-input-start/delta/end`) AND a doGenerate-only mock AND an abort fixture that emits `{type:"abort"}` then CLOSES the stream without throwing (this mirrors the real AI SDK — ai/dist/index.js:9002-9018 closes gracefully; a throwing mock would hide the abort bug). Write failing tests asserting (a) a streamText-backed source yields parts in order, (b) a doGenerate-only model yields a synthesized equivalent sequence in COMMITTED order (reasoning before text, mirroring mapping.ts:62-66 `assistantReasoningFirstParts`; per tool call: `tool-call-input-start` + one `tool-call-input-delta` with the full input JSON text + `tool-call-input-end`), (c) `isLanguageModelObject` accepts a doGenerate-only model. Then GREEN: new `packages/runtime/src/llm/model-step-stream.ts` exposing one async-iterable part source (streamText when `doStream` exists — prefer `result.stream`; confirm at implementation time whether `fullStream` is `@deprecated` in the installed index.d.ts and use the non-deprecated alias; else run `generateText` and synthesize the part sequence from its result) plus final-result accessors; relax the `doStream === "function"` requirement at model-step-selection.ts:127-141 (doGenerate stays required); typecheck-confirm `streamText` accepts `toolOrder`/`activeTools` (shared RequestOptions). Must NOT: change `generateModelStepResult` callers' result shape; add any new package dependency.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3
  References: `packages/runtime/src/llm/model-step.ts:82` (current generateText call); `packages/runtime/src/llm/model-step-selection.ts:110-141`; `packages/runtime/src/testing/mock-language-model-v4-test-utils.ts`; AI SDK ground truth `node_modules/.pnpm/ai@7.0.34_zod@4.4.3/node_modules/ai/dist/index.d.ts` — `TextStreamPart` union :2917, part payloads :2797-2916, `StreamTextResult` promises (`responseMessages`, `totalUsage`, `finalStep`, `finishReason`, `response`) :2600-2743, `streamText` signature :3356.
  Acceptance criteria: `cd packages/runtime && pnpm vitest run src/llm src/testing` green; RED output captured before GREEN; mutation proof — deleting the adapter branch fails the doGenerate-only test.
  QA scenarios: happy = vitest file for model-step-stream passes (Evidence `.omo/evidence/streaming-support/task-2-stream-source.txt`); failure = doGenerate-only mock without adapter rejects/throws — captured failing first.
  Commit: Y | feat(runtime): unify model step on a single stream source
- [x] 4. Ephemeral stream event kinds in the AgentEvent protocol
  What to do: RED first — failing tests in `packages/runtime/src/thread/protocol/events.test.ts` + `packages/runtime/src/contracts/root-api-events.test.ts` for the five new kinds, the `streamAgentEventTypes` classifier set, `StreamAgentEvent` type, and `isStreamAgentEvent` guard exported from the package root. Then GREEN: add `AssistantOutputDelta`, `AssistantReasoningDelta`, `ToolCallInputStart`, `ToolCallInputDelta`, `ToolCallInputEnd` interfaces + union members in `packages/runtime/src/thread/protocol/events.ts:81-109`, the classifier set beside :113-136, and root export in `packages/runtime/src/index.ts`. Delta kinds MUST NOT join `visibleAgentEventTypes`/`lifecycleAgentEventTypes`/`toolAgentEventTypes`/`telemetryAgentEventTypes`. Must NOT: alter existing kinds or classifier membership; persist anything.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3, 5, 8
  References: `packages/runtime/src/thread/protocol/events.ts:81-182`; `packages/runtime/src/contracts/root-api-events.test.ts:18-56`; `packages/runtime/src/contracts/root-api.test.ts:64-144` (export-surface rules).
  Acceptance criteria: `pnpm vitest run src/thread/protocol src/contracts` green in `packages/runtime`; `pnpm --filter @minpeter/pss-runtime typecheck` green.
  QA scenarios: happy = contract tests pass (Evidence `.omo/evidence/streaming-support/task-4-protocol.txt`); failure = guard misclassification (e.g. delta in visible set) fails the classifier test — shown RED first.
  Commit: Y | feat(runtime): add ephemeral stream event kinds
- [x] 3. Wire the model step to emit stream events with final-result parity
  What to do: RED first — failing tests asserting (a) `generateModelStepResult` with a doStream mock invokes `onStreamEvent` with `assistant-output-delta`/`assistant-reasoning-delta`/`tool-call-input-*` events in stream order BEFORE resolving, (b) returned `ModelStepResult` (`messages`, `usage` incl. `modelUsageEvent` fields) is identical in shape to today's, (c) CRITICAL abort semantics: the AI SDK closes the stream GRACEFULLY on abort (emits `{type:"abort"}` part then closes — it does NOT throw; ai/dist/index.js:9002-9018), so a mid-stream abort must be detected EXPLICITLY (abort part seen OR `signal.aborted` after the loop) and turned into a thrown AbortError so `readModelOutput`'s existing catch (`step-output.ts:33-45`) returns `"aborted"` — test asserts NO committed output is built from partial stream content, (d) mid-stream error propagates like generateText errors today, (e) no unhandled promise rejections on the abort/error path (the 5 result promises must be drained). Then GREEN: `packages/runtime/src/llm/model-step.ts` replaces the `generateText` call (~:70) with the todo-2 source, maps parts to the todo-4 event kinds inside the llm layer (tool-input `id` → `toolCallId`, `delta` → `inputTextDelta`), and awaits the result promises for `responseMessages`/`usage` (NOT `totalUsage` — it is @deprecated in ai@7.0.34 and `usage` is what `model-usage.ts:30-36` consumes today)/`finalStep`/`finishReason`/`response` using this exact drain pattern: `try { for await (part of source) { map+forward } ; const […] = await Promise.all([...5 promises...]); return result } catch (error) { await Promise.allSettled([...same 5 promises...]); throw error }`. Add optional `onStreamEvent?: (event: StreamAgentEvent) => void` to `ModelStepOptions` in `model-step-types.ts`. Must NOT: change `ModelStepResult` shape; emit committed events from deltas; buffer whole deltas before forwarding (forward per part); use `totalUsage`.
  Parallelization: Wave 2 | Blocked by: 2, 4 | Blocks: 5
  References: `packages/runtime/src/llm/model-step.ts:27-105`; `packages/runtime/src/llm/model-step-types.ts`; `packages/runtime/src/llm/model-usage.ts`; `packages/runtime/src/agent/loop/step-output.ts:21-50` (abort contract).
  Acceptance criteria: `pnpm vitest run src/llm src/agent/loop` green; existing llm/loop suites unmodified and green (characterization).
  QA scenarios: happy = new model-step stream tests pass (Evidence `.omo/evidence/streaming-support/task-3-model-step.txt`); failure = abort test proves no hang/no committed output on mid-stream abort.
  Commit: Y | feat(runtime): emit stream events from the model step
- [x] 5. Ephemeral delta plumbing through the turn event stream
  What to do: RED first — failing integration tests (thread runtime, memory host): (i) `thread.send` with a doStream mock yields deltas on `turn.events()` between `step-start` and committed `assistant-output`; (ii) ORDERING under fire-and-forget: deltas emitted from inside `readModelOutput` precede the committed `assistant-output` (pins the sync invariant below); (iii) durable replay `thread.events()` contains ZERO delta kinds; (iv) committed event sequence byte-identical to a non-streaming baseline; (v) deltas emitted during a `captureObserverEvents` window are NOT captured/flushed as observer events. Then GREEN: `ThreadEventDispatcher.emitStreamEvent(run, event): void` — SYNCHRONOUS body of exactly `run.emit(event)` (mirror the existing sync `emitProcessedEvent`; no interception, no plugin observe, no record, NO await — the ordering guarantee of deltas-vs-committed events depends on reaching `run.emit` synchronously through `emitTurnEvent`'s early branch); early `isStreamAgentEvent` branch in `emitTurnEvent` (`turn-events.ts:17-81`) routing to it with no preceding await; `readModelOutput` (`step-output.ts:21-50`) gains an `onStreamEvent` param (also added at the `runAgentLoop` call site, `run.ts:34-41`) wired as `(event) => { void emit(event).catch(() => {}); }` (NOT `try { void emit(event); } catch {}` — the try form misses async rejections); defense-in-depth durability guard: `recordDurableThreadEvent` in `thread-event-log.ts` throws a `TypeError` when given a stream event kind, so a future refactor cannot silently persist deltas. Must NOT: reorder committed events; add per-delta awaits in the hot path; change flush boundaries.
  Parallelization: Wave 3 | Blocked by: 3, 4 | Blocks: 6, 7, 8
  References: `packages/runtime/src/thread/runtime/turn-events.ts:44-60` (recordEvent paths to bypass); `packages/runtime/src/thread/runtime/thread-event-dispatcher.ts:120-129`; `packages/runtime/src/thread/protocol/turn.ts:47-53` (`emit` non-blocking); `packages/runtime/src/thread/runtime/queued-input-processor.ts:153-166` (emit wiring); `packages/runtime/src/agent/loop/run.ts:27-80`.
  Acceptance criteria: `pnpm vitest run src/thread` green; new integration test file green; durable-replay assertion machine-checked.
  QA scenarios: happy = integration test passes with ordering assertion (Evidence `.omo/evidence/streaming-support/task-5-plumbing.txt`); failure = if any delta lands in the durable buffer, the replay assertion fails — shown RED first.
  Commit: Y | feat(runtime): stream deltas ephemerally through turn events
- [x] 6. TUI renders token deltas incrementally
  What to do: RED first — failing adapter tests: (a) delta kinds map to `text-delta`/`reasoning-delta`/`tool-input-start/delta/end` parts (RENAME: runtime kinds are `tool-call-input-start/delta/end`, TUI parts are `tool-input-start/delta/end`; pass `toolCallId` through — `getToolInputId` at stream-handlers.ts:17-21 reads `part.id ?? part.toolCallId`), (b) with deltas seen in a step, the committed `assistant-output` does NOT re-render its text (boundary parts only), (c) committed-only step (no deltas) still renders whole text AND a committed-only `tool-call` (no preceding tool-input deltas — providers without tool-input streaming produce this) still renders (fallback). Then GREEN: `apps/coding-agent/src/tui/agent-event-stream.ts:57-138` per-step tracking reset on `step-start`; tool-input parts feed the existing handlers (`stream-handlers.ts:163-216`). Must NOT: change `stream-views.ts`/`stream-handlers.ts` (already incremental); buffer deltas.
  Parallelization: Wave 4 | Blocked by: 5 | Blocks: 9
  References: `apps/coding-agent/src/tui/agent-event-stream.ts:50-138`; `apps/coding-agent/src/tui/stream-handlers.ts:144-216,357-377`; `apps/coding-agent/src/tui/stream-views.ts:31-95`.
  Acceptance criteria: `pnpm --filter @minpeter/pss-coding-agent test` green; new adapter tests cover (a)-(c).
  QA scenarios: happy = adapter tests pass (Evidence `.omo/evidence/streaming-support/task-6-tui.txt`); failure = double-render regression test fails when dedupe removed (mutation proof).
  Commit: Y | feat(coding-agent): render token deltas in the TUI
- [x] 7. exec streams deltas as NDJSON and examples print live text
  What to do: RED first — failing exec test: with a doStream-capable scripted model, stdout NDJSON contains `assistant-output-delta` `agent_event` lines while `result.events` (and `--result-file`) contains NONE; `finalText` still equals the committed text. Then GREEN: filter stream kinds out of the `events` accumulator in `apps/coding-agent/src/exec.ts:151-154` (`isStreamAgentEvent` guard); update `examples/basic/src/drain.ts`, `examples/local-file-agent/src/drain.ts`, `examples/sync-subagent/src/print-run.ts`, `examples/background-subagent/src/print-run.ts` to write `assistant-output-delta` text live and not log delta kinds in the default branch, keeping committed-only fallback. Must NOT: change the NDJSON schema name (`pss-headless-v1`) or the committed-event accumulation.
  Parallelization: Wave 4 | Blocked by: 5 | Blocks: 9
  References: `apps/coding-agent/src/exec.ts:71-99,135-172`; `examples/basic/src/drain.ts:3-19`; `examples/sync-subagent/src/print-run.ts:3-27`.
  Acceptance criteria: `pnpm --filter @minpeter/pss-coding-agent test` green; examples typecheck via `pnpm typecheck`.
  QA scenarios: happy = exec NDJSON artifact captured (Evidence `.omo/evidence/streaming-support/task-7-exec.ndjson`); failure = `result.events` containing a delta kind fails the test — shown RED first.
  Commit: Y | feat(coding-agent): stream deltas through exec and examples
- [x] 8. Pin stream-event contracts and durability exclusion
  What to do: RED first — failing pins: (a) `contracts/channel-api.test.ts` — all five delta kinds project to `undefined` via `projectChannelAssistantDelivery`; (b) durable exclusion — a doStream turn committed to the file execution store yields a `thread-events/*.jsonl` with zero delta kinds (extend or add a store-level test near `platform/file/storage/file-execution-store.test-support`); (c) `contracts/root-api.test.ts` export surface includes `isStreamAgentEvent`/`StreamAgentEvent` and still forbids run-stream helpers. Then GREEN: minimal test/export wiring only (production behavior landed in todos 4-5). Must NOT: weaken existing contract assertions; add schema versioning (none exists — storage validation is `type`-string only, event-log-schemas.ts:75-77).
  Parallelization: Wave 5 | Blocked by: 4, 5 | Blocks: F-wave
  References: `packages/runtime/src/contracts/channel-api.test.ts:27-77`; `packages/runtime/src/channel/index.ts:16-26`; `packages/runtime/src/contracts/root-api.test.ts:64-144`; `packages/runtime/src/platform/file/storage/file-execution-store/event-log-schemas.ts:75-77`.
  Acceptance criteria: `pnpm vitest run src/contracts src/platform/file` green in `packages/runtime`.
  QA scenarios: happy = contract suite passes (Evidence `.omo/evidence/streaming-support/task-8-contracts.txt`); failure = removing the ephemeral bypass makes (b) fail — mutation-proven in todo 5, re-verified here.
  Commit: Y | test(runtime): pin stream event contracts
- [x] 9. Document streaming and add tegami release letters
  What to do: root `README.md` — streaming paragraph in the `turn.events()` section (keep the literal `for await (const event of turn.events())` string intact, pinned by `scripts/runtime-docs.test.mjs:38`); `packages/runtime/README.md` — new "Streaming deltas" section documenting the five kinds, ephemeral semantics (never persisted, not in `thread.events()` replay), classifier, unified streaming/non-streaming behavior, and consumer dedupe guidance; `apps/coding-agent/README.md` — TUI/exec streaming notes; tegami letters `.tegami/2026-07-23-runtime-streaming.md` (runtime) and `.tegami/2026-07-23-coding-agent-streaming.md` mirroring the frontmatter of a recent feat letter (e.g. `.tegami/2026-07-19-channel-adapter-contract.md`). Must NOT: edit the pinned doc-guard loop string; claim worker-agent streaming.
  Parallelization: Wave 5 | Blocked by: 6, 7 | Blocks: F-wave
  References: `README.md:43-70`; `packages/runtime/README.md:41-56,373-427,519-522,965-966,1018-1020`; `apps/coding-agent/README.md:16-34`; `scripts/runtime-docs.test.mjs:38`; `.tegami/2026-07-19-channel-adapter-contract.md` (frontmatter shape).
  Acceptance criteria: `pnpm test` at repo root green (includes `scripts/runtime-docs.test.mjs`); letters validate via the repo's tegami tooling (`pnpm tegami --help` to discover the check command; if none exists, mirror frontmatter exactly).
  QA scenarios: happy = doc-guard test passes (Evidence `.omo/evidence/streaming-support/task-9-docs.txt`); failure = removing the guard string from README makes `runtime-docs.test.mjs` fail — verified by reading the assertion, not by breaking it.
  Commit: Y | docs(runtime): document streaming deltas

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Independent oracle: re-read this plan + full branch diff; verify every Must have landed, every Must NOT have held, every todo's evidence artifact exists. APPROVE/REJECT with citations.
- [x] F2. Full quality gates
  In the worktree root: `pnpm test` (turbo, all packages + `scripts/*.test.mjs`), `pnpm typecheck`, `pnpm build`, `pnpm lint` — each exits 0. Evidence `.omo/evidence/streaming-support/f2-gates.txt`.
- [x] F3. Real manual QA
  (a) Scripted-model demo in the worktree: `thread.send` → `turn.events()` consumer recording monotonic timestamps per event, proving deltas arrive BEFORE the committed `assistant-output` and interleave live (Evidence `.omo/evidence/streaming-support/f3-demo-transcript.txt`); (b) `pss exec` against a scripted/mock model producing NDJSON with delta lines (Evidence `.omo/evidence/streaming-support/f3-exec.ndjson`); (c) abort mid-stream: interrupt during delta flow → `turn-abort`, no committed output, zero deltas in durable replay (Evidence `.omo/evidence/streaming-support/f3-abort.txt`). All spawned processes killed afterwards; cleanup receipts recorded.
- [x] F4. Scope fidelity
  Independent oracle: verify NO changes under `apps/worker-agent/`, NO persisted delta kinds (storage tests + code read), NO new root run-stream API, NO plugin delta hooks, NO opt-in config surface. APPROVE/REJECT with citations.

## Commit strategy
Atomic Conventional Commits on `feat/streaming-support` in the task worktree, one per todo marked Commit: Y, each green on its own (vitest scope + typecheck before commit). Order: 2/4 (either first), 3, 5, 6/7, 8, 9. No push, no PR, no changes to `main`. Final commit footer: `Plan: .omo/plans/streaming-support.md`. The user's directive "구현해줘" preauthorizes these branch commits.

## Success criteria
1. Happy path: a `doStream` model turn emits `assistant-output-delta` / `assistant-reasoning-delta` / `tool-call-input-*` events on `turn.events()` in stream order between `step-start` and the committed events; committed `ModelStepResult` and durable record are byte-identical in shape to the pre-change behavior. Evidence: task-3/task-5 vitest + f3-demo-transcript.
2. Unified path: a `doGenerate`-only model produces the SAME event sequence shape (synthesized single deltas) through the SAME code path — no consumer branches on model capability. Evidence: task-2 mutation-proven test.
3. Durability/regression: zero delta kinds in durable replay (`thread.events()`) and in file/SQLite event logs; full pre-existing suite green; abort mid-stream (graceful AI SDK close, `{type:"abort"}` part) → `turn-abort` with NO committed output built from partial stream content, no persisted deltas, and no unhandled promise rejections. Evidence: task-5/task-8 pins + f2-gates + f3-abort.
4. Adversarial risk: consumers never double-render (TUI dedupe mutation-proven); `pss exec` `result.events` excludes deltas while stdout streams them; channel delivery projects all delta kinds to `undefined`. Evidence: task-6/task-7/task-8 artifacts.
