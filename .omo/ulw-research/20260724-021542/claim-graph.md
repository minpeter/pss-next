# Claim graph

## Verified claims
- C1 VERIFIED: prose regexes are unsuitable as the primary category mechanism.
  Evidence: APICallError structured contract, OpenCode/Codex/Gemini designs,
  Senpi's downstream regex debt, localization/proxy counterexamples.
- C2 VERIFIED: pss needs a provider-neutral normalized envelope before TUI
  presentation. Evidence: OpenCode LLMError/APIError, CodexErrorInfo,
  Senpi MCP errors, current pss string-loss trace.
- C3 VERIFIED: `code/type -> status -> typed class -> unknown` is the correct
  layered classification order. Counterevidence: status-only fails for
  service-specific throttling and proxy rewrites.
- C4 VERIFIED: request IDs should be read from structured headers/data and
  retain their source name. Evidence: OpenAI, Anthropic, AWS, Google,
  Cloudflare, current OneRouter `x-infron-request-id`.
- C5 VERIFIED: provider message remains valuable display context but should not
  select category-specific hints.
- C6 VERIFIED: `retryable` observation and `willRetry` runtime policy are
  different fields.
- C7 VERIFIED: default TUI output must exclude stack, raw response/request
  bodies, headers, and credentials; redacted diagnostics are a separate
  surface.
- C8 VERIFIED: non-HTTP and mid-stream failures require explicit
  stream/network/unknown fallbacks.
- C9 VERIFIED: an additive optional envelope under existing `turn-error`
  preserves compatibility while allowing the TUI regex to be removed.

## Candidate claims
- None unresolved.
