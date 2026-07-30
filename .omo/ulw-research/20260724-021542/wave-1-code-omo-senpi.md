# Wave 1 — OMO/Senpi local implementation

## Key findings
- Senpi delegates provider normalization to `@earendil-works/pi-ai`.
- `normalizeProviderError` probes multiple structured SDK fields:
  `statusCode`, `status`, `$metadata.httpStatusCode`, and
  `$response.statusCode`.
- The normalized shape separates `status`, `body`, `message`, and whether the
  message already carries the body.
- TUI rendering consumes a typed `AssistantMessage` boundary with
  `stopReason`, optional structured `stopDetails`, and `errorMessage`.
- Retry/fallback is classified separately from presentation and produces
  stable reasons: `transient`, `refusal`, and `hard-error`.
- OMO's own task layer maps `Error.name` to stable codes such as
  `recipient_backpressure`, rather than parsing display messages.
- Senpi still uses message regexes as secondary compatibility classifiers for
  retry and context overflow, but not as the only error envelope.

## Primary local sources
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/error-body.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/error-body.d.ts`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/types.d.ts`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/retry.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/dist/modes/interactive/components/assistant-message.js`
- `/home/minpeter/.local/share/senpi/lib/node_modules/@code-yeongyu/senpi/dist/core/retry-fallback/controller.d.ts`
- `/home/minpeter/.senpi/agent/omo-senpi/plugin/extensions/omo.js`

## EXPAND markers
- LEAD: inspect `pi-ai/dist/utils/diagnostics.js` — WHY: may provide a
  structured diagnostic channel separate from display text — ANGLE:
  diagnostics envelope.
- LEAD: inspect OpenCode provider adapters in `pi-ai` — WHY: shows how
  provider-specific inputs are normalized into the shared shape — ANGLE:
  adapter boundary.
- LEAD: inspect fallback logs/rendering — WHY: validates separation of normal
  UI and detailed retry diagnostics — ANGLE: debug surface.

## Claim verdicts
- CONFIRMED: Senpi's primary architecture is typed normalization first,
  presentation second.
- QUALIFIED: Senpi still uses message heuristics for compatibility where SDK
  structure is missing; this is evidence for a low-confidence fallback only,
  not for removing all message inspection.
