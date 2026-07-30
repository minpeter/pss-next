# Wave 2 — structured Senpi precedents

## Reusable shapes

### CodexErrorInfo
- Discriminated taxonomy with context, usage, overload, policy, unauthorized,
  bad request, internal, connection, stream, sandbox, and unknown variants.
- HTTP-bearing variants carry `httpStatusCode: number | null`.
- Exhaustive serialization proves the taxonomy can cross process boundaries.

### TurnError / ErrorNotification
- `TurnError`: user message + structured category + optional additional detail.
- `ErrorNotification`: turn error + `willRetry` + thread/turn correlation.

### MCP error hierarchy
- Stable `kind`, optional `retriable`, phase, server name, and cause.
- Unknown values are recursively probed through `response`/`cause`.
- Message inspection is a last compatibility fallback after numeric fields.

### pi-messages diagnostics
- Versioned diagnostic metadata preserves provider, model, URL, status,
  status text, parsed error, bounded raw body, and timestamp.
- Diagnostics are separate from the display message.

### Non-HTTP stream failures
- Recovery terminal emits structured `stopReason: "error"` even when no HTTP
  status exists.
- Therefore a generic envelope must always support `status: undefined` and
  stream/transport categories.

## Primary local source checkout
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/modes/app-server/rpc/errors.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/modes/app-server/protocol/terminal.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/ai/src/utils/error-body.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/ai/src/api/pi-messages.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/ai/src/tool-call-middleware/recovery-stream-terminal.ts`

## EXPAND markers
- LEAD: map these fields onto pss-runtime's current string-only `turn-error`
  event — WHY: identify the smallest migration boundary — ANGLE: local design.
- LEAD: decide whether retry policy belongs in the envelope or remains runtime
  policy — WHY: avoid conflating observed `retryable` with chosen `willRetry`
  — ANGLE: policy separation.

## Claim verdicts
- CONFIRMED: a provider-neutral envelope is already proven in Senpi's adjacent
  systems; no need to invent a vendor-specific parser.
- CONFIRMED: `message`, `category`, `status`, `retryable`, `requestId`, and
  redacted diagnostics are distinct concerns.
