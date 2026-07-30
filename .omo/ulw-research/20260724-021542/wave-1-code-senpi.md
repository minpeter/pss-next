# Wave 1 — Senpi provider and TUI error pipeline

## Key findings
- Provider SDK catches funnel through `normalizeProviderError`, which extracts
  structured status/body from multiple SDK shapes.
- Senpi currently loses status at the `AssistantMessage` boundary by embedding
  it in `errorMessage`; downstream retry and overflow logic then uses extensive
  message heuristics.
- Anthropic refusal/sensitive stop reasons are a successful structured
  exception: provider adapter maps them to typed `stopDetails`.
- MCP handling is another useful hybrid: typed `kind`, `retriable`, and
  `serverName` first; message matching only as a fallback.
- App-server defines a substantial `codexErrorInfo` taxonomy but turn failures
  currently hardcode it to `other`.
- Senpi deliberately separates user-visible errors from redacted debug logs,
  hidden stdout/stderr capture, and structured fallback logs.
- Response status/headers already flow through an `after_provider_response`
  hook, but core TUI errors do not consume them for correlation IDs.

## Primary local sources
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/dist/modes/app-server/rpc/errors.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/mcp/errors.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/dist/core/retry-fallback/log.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js`

## EXPAND markers
- LEAD: inspect app-server `CodexErrorInfo` type definitions — WHY: candidate
  provider-neutral category vocabulary — ANGLE: taxonomy.
- LEAD: inspect recovery stream terminal failures — WHY: tests non-HTTP errors
  that bypass provider classification — ANGLE: unknown/stream errors.
- LEAD: inspect response-header hook consumers — WHY: request IDs may be
  recoverable without parsing messages — ANGLE: correlation metadata.
- LEAD: inspect structured MCP error implementation — WHY: existing Senpi
  precedent for structured-first plus fallback matching — ANGLE: normalizer.

## Claim verdicts
- CONFIRMED: current Senpi implementation validates the concern; it has a
  structured normalizer but loses information too early and pays for that with
  downstream message regexes.
- CONFIRMED: the best Senpi precedent is MCP/stopDetails, not the provider
  `errorMessage` regex banks.
