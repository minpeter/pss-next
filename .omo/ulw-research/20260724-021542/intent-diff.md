# Intent diff — generic provider error presentation

## Core question
How should a coding-agent CLI/TUI normalize and present model-provider failures
without matching vendor-specific human message strings, using Senpi/OMO and
established SDK/CLI implementations as references?

## Expected truths
- Error classification should prefer structured fields such as status, code,
  error type, and typed error classes over message text.
- Provider adapters should normalize transport/provider errors before the UI
  chooses wording or styling.
- The user surface should be concise and actionable while preserving richer
  diagnostics for logs/debug views.
- Unknown providers and unknown error types must still render safely through a
  generic fallback.
- Correlation/request IDs should be carried as metadata when available, not
  extracted from one vendor's prose format.
- Stack traces, request bodies, headers, and credentials should not appear in
  the default TUI surface.

## Axes
1. Senpi local code — locate error normalization, provider adapters, and
   terminal presentation patterns.
2. OMO/OpenCode local code — locate generic API/LLM error handling and UI
   formatting boundaries.
3. Official SDKs — inspect Vercel AI SDK and OpenAI-compatible error contracts
   for typed status/code/response metadata.
4. OSS coding agents — inspect OpenCode/Claude-like CLIs for generic error
   categories, debug detail separation, and retry guidance.
5. Adversarial/security — identify brittle matching, secret leakage, and
   localization/versioning failure modes.

Codebase relevant: yes · External: yes · Browsing: yes · Verification likely:
yes · Final material format: markdown only

## Current implementation delta
- Current TUI extracts a request ID from `(request id: ...)` prose.
- Current credential hint uses a regex containing `user banned`, `token
  status`, and other English message fragments.
- Current runtime correctly suppresses the AI SDK's default console stack and
  preserves the original error object until the `turn-error` string boundary.
