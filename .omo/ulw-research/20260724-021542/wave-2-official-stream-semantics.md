# Wave 2 — AI SDK pre-stream and mid-stream semantics

## Pre-stream failure
- OpenAI-compatible non-2xx responses become `APICallError`.
- Status, response headers, raw body, parsed data, retryability, and cause are
  available.
- The reported OneRouter 403 is this case; its generic classification can use
  status 403 and preserve the provider message without matching `User banned`.

## Mid-stream failure
- Provider error chunks, schema parse errors, and transport read errors are not
  necessarily `APICallError`.
- They may have no status or headers on the error object.
- The runtime must preserve an `unknown/stream/transport` fallback and should
  capture step response metadata separately when available.

## Promise and stream behavior
- Mid-stream error parts can produce `finishReason: "error"` while result
  promises resolve if partial output exists.
- Correct normalization must occur on the error part, not only in `finalize()`
  catch handling.

## Primary sources
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/provider/src/errors/api-call-error.ts
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/provider-utils/src/response-handler.ts
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts
- https://ai-sdk.dev/docs/ai-sdk-core/error-handling

## EXPAND markers
- LEAD: design normalization for `RetryError.lastError` and nested causes —
  WHY: final pre-stream error may be wrapped — ANGLE: recursive extraction.
- LEAD: define category behavior for partial-output mid-stream failures — WHY:
  they are observable but may lack HTTP metadata — ANGLE: stream semantics.

## Claim verdicts
- CONFIRMED: current dependencies expose enough structure for reported
  pre-stream failures.
- CONFIRMED: APICallError-only handling would be incomplete; the fallback path
  is part of the core contract.
