# Wave 1 — official SDK contracts

## Vercel AI SDK v7
- `APICallError` exposes stable structured fields:
  `statusCode`, `responseHeaders`, `responseBody`, `isRetryable`, `data`,
  `cause`, `url`, and `requestBodyValues`.
- Identity should use `APICallError.isInstance(error)`, not `instanceof`,
  because the marker survives duplicate package versions.
- OpenAI-compatible error `message/type/param/code` is parsed under
  `APICallError.data.error`.
- Request IDs are available from response headers; there is no generic
  top-level request ID.
- `streamText.onError` is a logging side-effect hook and defaults to
  `console.error`.
- The same error is delivered as an `error` stream part.
- AI SDK's official UI seam deliberately defaults to generic
  `"An error occurred."`, demonstrating separation between raw SDK error and
  client-visible copy.

## OpenAI Node SDK
- `APIError` preserves `status`, headers, parsed error body, code, param, type,
  and request ID.
- Status maps to typed subclasses such as `AuthenticationError`,
  `PermissionDeniedError`, `RateLimitError`, and `InternalServerError`.
- Retry policy is structural and handles 408/409/429/5xx plus connection
  errors; it does not require provider prose.

## Primary sources
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/provider/src/errors/api-call-error.ts
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/provider-utils/src/response-handler.ts
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/openai-compatible/src/openai-compatible-error.ts
- https://ai-sdk.dev/docs/ai-sdk-core/error-handling
- https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error
- https://github.com/openai/openai-node/blob/4ced1a8eaba3f5e960b94090a75e8048f7642439/src/core/error.ts

## EXPAND markers
- LEAD: inspect `RetryError.lastError/errors` unwrapping — WHY: runtime may see
  a retry wrapper instead of APICallError — ANGLE: cause traversal.
- LEAD: verify GatewayError parallel contract — WHY: future gateway route may
  not be APICallError — ANGLE: typed union.
- LEAD: inspect mid-stream SSE failures after HTTP 200 — WHY: no HTTP error
  status may exist — ANGLE: stream transport category.

## Claim verdicts
- CONFIRMED: the current dependency already carries enough structured data to
  remove `User banned`/`token status` matching.
- CONFIRMED: a normalizer should run before converting the error to the current
  string-only `turn-error` event.
