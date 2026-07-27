---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Add provider-neutral structured turn errors

`turn-error` keeps its required safe `message` and can now include an optional,
versioned `error` envelope with a stable category, HTTP status, bounded
provider code/type, observed retryability, retry-after, and labeled
correlation IDs.

The runtime normalizes AI SDK `APICallError` and wrapped `RetryError` failures
before provider detail is reduced to prose. Network, timeout, cancelled, and
unknown errors retain generic fallbacks. Structured metadata is durable and
visible to replay and plugins, while raw request/response bodies, headers,
URLs, stacks, credentials, causes, and provider messages are excluded.

`TurnErrorMetadataV1`, `TurnErrorCategory`, and `TurnErrorCorrelationId` are
exported from the package root. Existing stored `turn-error` records without
metadata remain valid.
