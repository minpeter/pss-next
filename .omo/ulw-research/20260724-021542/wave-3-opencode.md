# Wave 3 — OpenCode closest analogue

## Architecture
- Native LLM layer classifies errors into a typed `LLMError` union with ten
  reason classes.
- Reason classes carry stable retryability and optional retry-after/rate-limit
  metadata.
- HTTP context extracts multiple correlation IDs from response headers.
- Session/core layer emits a typed error schema rather than a display-only
  string.
- TUI presentation and retry overlays consume that schema separately.
- Legacy AI SDK adapters still use heuristics for compatibility, but after the
  structured path.

## Primary sources
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/llm/src/provider-error.ts
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/core/src/v1/session.ts
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/opencode/src/provider/error.ts
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/opencode/src/session/retry.ts

## Claim verdicts
- CONFIRMED: OpenCode is the closest TypeScript/AI-SDK precedent for the
  recommended pss boundary.
