# Plan — runtime per-attempt model-attempt events

## Problem
pss-runtime is blind to AI SDK retries. `streamText({...options, onError})`
(packages/runtime/src/llm/model-step-stream.ts:139) subscribes to nothing that fires
per physical attempt, so N HTTP attempts collapse into one `attemptId`
(model-step.ts:69) and backoff waits vanish into ModelUsage.durationMs.
Only the app layer (coding-agent provider-observation.ts fetch wrap) can see attempts.

## Verified SDK facts (ai@7.0.51)
- streamText: `prepareRetries` per STEP (dist:9673) -> `retry(() => streamLanguageModelCall(...))` (9679).
- `onLanguageModelCallStart` / `onLanguageModelCallEnd` are passed INSIDE that closure (9702-9709).
- `streamLanguageModelCall` notifies callStart at its top (8306-8312) => FIRES ONCE PER ATTEMPT (retries included).
- `onLanguageModelCallEnd` is notified from the stream transform on `model-call-end` (8495-8520)
  => fires ONLY on a successfully finished stream. A doStream throw never reaches it.
- Retry helper (provider-utils 5.0.20:3432) exposes only shouldRetry/getDelayInMs/createRetryError,
  all SDK-owned => no caller hook for "retry N, waiting Xms".

## Design (elegant, not cheapest)
Per-attempt truth comes from the SDK callback; outcome is resolved by the runtime.
- `onLanguageModelCallStart` -> emit `model-attempt` `{ phase: "start", attempt: n }`, n from a
  runtime-owned counter scoped to the model step (shares the existing `attemptId`).
- `onLanguageModelCallEnd` -> emit `{ phase: "end", outcome: "succeeded" }`.
- A start with no matching end, resolved when the step throws => `{ phase: "end", outcome: "failed", error }`,
  error normalized by REUSING the existing turn-error classification (thread/runtime/turn-error-*),
  giving category/status/retryAfterMs for free.
- New module `llm/model-attempt.ts` owns counter + event normalization, mirroring model-usage.ts style
  (sanitized identifiers, exact-optional spreads). Keep under 250 pure LOC.
- Event registered in streamAgentEventTypes (event-classifiers.ts:28) => ephemeral like context-usage,
  never persisted (thread-event-log.ts:27, turn-events.ts:58), flows through existing
  onStreamEvent -> step-output.ts -> run.ts -> thread-event-dispatcher.emitStreamEvent.
- Exported from src/index.ts + public-api snapshot updated via pnpm api:update.

## Waves
1. RED tests (criteria 1+2) in packages/runtime/src/llm/model-attempt.test.ts using existing
   mock-language-model-v4-test-utils; criterion 2 uses a doStream that throws APICallError 429 once.
2. GREEN: events.ts type + classifier entry + llm/model-attempt.ts + wire into model-step-stream.ts
   and model-step.ts + index.ts exports.
3. Regression: runtime suite, api:update + api:check, LSP diagnostics.
4. Real surface: pss exec NDJSON against flash.minpeter.com; grep model-attempt.
5. Tegami entry + commits.
