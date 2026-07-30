# Wave 3 — pss migration boundary

## Current flow
1. AI SDK emits an `error` stream part containing `unknown`.
2. `model-step-stream` records/rethrows the raw error.
3. `model-step` ignores the error part and fails during finalize.
4. turn recovery converts the `Error` to `{ type: "turn-error", message }`.
5. persistence, replay, exec, and plugins see only the string message.
6. coding-agent TUI tries to reconstruct category and request ID from prose.

## Smallest generic design

Keep backward compatibility:

```ts
type TurnErrorEvent = {
  type: "turn-error";
  message: string;
  error?: {
    version: 1;
    category:
      | "authentication"
      | "permission"
      | "rate-limit"
      | "quota"
      | "bad-request"
      | "context-overflow"
      | "timeout"
      | "network"
      | "upstream"
      | "stream"
      | "unknown";
    status?: number;
    code?: string;
    providerType?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    correlationIds?: readonly {
      source: string;
      value: string;
    }[];
  };
};
```

`message` remains the UI-safe provider summary. The envelope contains only
plain JSON-safe observations. It contains no request body, headers, raw body,
stack, credential, or arbitrary provider object.

## Classification order
1. Traverse known wrappers and `cause` safely.
2. Typed provider/SDK class or stable marker.
3. Parsed provider `code`/`type`.
4. HTTP status and SDK `isRetryable`.
5. Transport/abort/stream typed error.
6. Unknown.

Message text is display fallback only. Compatibility message matching, if
temporarily retained, must be explicit low-confidence metadata and must not
select account-specific remediation.

## Presentation
- Title from category.
- Provider message shown as context, never treated as a universal diagnosis.
- Hint from category/status:
  - authentication: check credentials.
  - permission: check account/model access.
  - rate-limit: wait or inspect quota.
  - timeout/network/upstream: retry or inspect connectivity/provider status.
  - unknown: no speculative hint.
- Correlation IDs rendered with source labels in a compact diagnostic footer.

## Policy separation
- `retryable`: observed capability/SDK classification.
- `willRetry`: runtime decision; do not persist it unless retry behavior is
  actually implemented at that event boundary.
- UI must not infer `willRetry` from `retryable`.

## Exact local touchpoints
- `packages/runtime/src/llm/model-step-stream.ts`
- `packages/runtime/src/llm/model-step.ts`
- `packages/runtime/src/thread/protocol/events.ts`
- `packages/runtime/src/thread/runtime/turn-error.ts`
- runtime event persistence/contract tests
- `apps/coding-agent/src/tui/agent-event-stream.ts`
- `apps/coding-agent/src/tui/error-presentation.ts`
- `apps/coding-agent/src/exec.ts` contract tests

## EXPAND markers
- No lead remains that could change the recommended boundary.
- Implementation-specific question remains: whether to normalize on the stream
  error part immediately or once in turn-error recovery; normalize once at the
  runtime boundary and reuse for both paths.

## Claim verdicts
- CONFIRMED: additive metadata preserves all current consumers.
- CONFIRMED: the current TUI regex can be removed once this envelope reaches
  the coding-agent.
