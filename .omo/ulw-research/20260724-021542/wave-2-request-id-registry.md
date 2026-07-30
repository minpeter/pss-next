# Wave 2 — status, retry, and correlation registry

## Generic observations
- HTTP status is a strong baseline but not a complete category: AWS may report
  throttling-style codes with HTTP 400, and proxies can rewrite statuses.
- Prefer parsed provider `code`/`type` over status when both exist, then status,
  then typed class/name, then an unknown fallback.
- `retryable` is an observation from the SDK/wire; it does not mean the runtime
  will retry.
- `Retry-After` accepts delay-seconds or HTTP-date and belongs in structured
  metadata.
- Request/correlation IDs are header-based and heterogeneous:
  `x-request-id`, `request-id`, `x-amzn-requestid`,
  `x-goog-request-id`, `cf-ray`, and gateway-specific IDs such as
  `x-infron-request-id`.
- Preserve the header name with the value instead of pretending every ID has
  identical semantics.

## Primary sources
- RFC 9110 and RFC 6585 for status/retry semantics.
- OpenAI Node and Anthropic TypeScript SDK source for request IDs.
- AWS Bedrock SDK/service error conventions.
- Google GenAI SDK and service header conventions.
- Cloudflare `cf-ray` documentation.

## EXPAND markers
- LEAD: validate the registry against pss's actual OneRouter response headers
  — WHY: ensure the reported request ID is available structurally — ANGLE:
  empirical local fixture.

## Claim verdicts
- CONFIRMED: correlation IDs should be an array/map with source labels.
- CONFIRMED: category mapping must be layered, not status-only.
