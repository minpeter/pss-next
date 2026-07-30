# Wave 1 — adversarial genericity review

## Key findings
- English message matching fails under localization, proxy/WAF rewriting,
  nested causes, and provider version changes.
- 401, 403, 407, 408, 409, 429, 5xx, and transport failures need distinct
  categories; `403` does not prove a banned account.
- Error causes and `AggregateError` members must be traversed to avoid losing
  the meaningful inner SDK error.
- Request IDs should come from typed fields or known response headers, with
  provider IDs separated from gateway IDs.
- TUI copy should communicate confidence and avoid turning a provider's prose
  into a universal diagnosis.
- Headers/bodies/stacks belong in a redacted debug surface, not the default
  terminal block.

## Primary contracts cited by worker
- OpenAI Node SDK `APIError`: status, headers, error, code, param, type,
  requestID from `x-request-id`.
- Anthropic TypeScript SDK `APIError`: status, headers, error, type, requestID
  from `request-id`.
- Google GenAI `ApiError`: status and message, demonstrating that the generic
  envelope must tolerate sparse SDKs.
- HTTP semantics: 401 invalid/missing authentication, 403 understood but
  refused, 407 proxy authentication, 429 rate limit with optional Retry-After.

## EXPAND markers
- LEAD: build a request-ID header registry — WHY: provider and gateway support
  handles differ — ANGLE: metadata normalization.
- LEAD: compare concrete fixture matrix across OpenAI, Anthropic, Google,
  proxy HTML, DNS/TLS, and abort errors — WHY: validate fallback exhaustiveness
  — ANGLE: adversarial cases.
- LEAD: add confidence levels — WHY: UI copy should not overclaim based on
  partial evidence — ANGLE: presentation semantics.

## Claim verdicts
- CONFIRMED: primary classification by provider prose is not robust.
- CONFIRMED: structured-first plus conservative fallback is the required
  generic design.
