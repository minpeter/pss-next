# Generic model-provider error handling — reference synthesis

## Conclusion

The staged `User banned`/`token status` message matching is overfit and should
not become the long-term contract. The provider message is useful to display,
but classification and remediation must come from structured SDK/transport
metadata before the runtime converts the error to a string.

The closest architecture for this TypeScript/AI-SDK stack is OpenCode:
normalize provider errors into a discriminated schema, carry it through the
session event, and let the TUI project category-specific copy. Senpi provides
the same good precedent in its MCP/Codex error types, while its older
provider-message regex banks demonstrate the maintenance cost of losing
structure too early.

## What the current dependencies already provide

Vercel AI SDK `APICallError` includes:

- `statusCode`
- `responseHeaders`
- `responseBody`
- `isRetryable`
- parsed `data`
- `cause`
- URL and request-body values

For the reported OneRouter error, this is enough to determine:

- HTTP category: 403 permission/refusal.
- Observed retryability: false.
- Provider summary: `User banned`.
- Correlation ID: `x-infron-request-id`.

None of those requires matching `User banned` or parsing
`(request id: ...)` from prose.

## Recommended pss boundary

Keep existing compatibility and add JSON-safe metadata:

```ts
type TurnErrorEvent = {
  type: "turn-error";
  message: string;
  error?: {
    version: 1;
    category:
      | "authentication"
      | "permission"
      | "rate-limit"
      | "quota"
      | "bad-request"
      | "context-overflow"
      | "timeout"
      | "network"
      | "upstream"
      | "stream"
      | "unknown";
    status?: number;
    code?: string;
    providerType?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    correlationIds?: readonly {
      source: string;
      value: string;
    }[];
  };
};
```

### Classification order

1. Unwrap known wrappers and recursive causes.
2. Read stable typed provider/SDK class.
3. Read parsed provider `code`/`type`.
4. Read HTTP status and SDK `isRetryable`.
5. Detect typed transport/abort/stream failure.
6. Fall back to `unknown`.

Provider prose is display-only fallback. If compatibility heuristics remain
temporarily, they must be explicitly low-confidence and cannot select
account-specific remediation.

### TUI projection

- Authentication: check credentials.
- Permission: provider refused the request; check account/model access.
- Rate limit: wait or inspect quota.
- Network/timeout/upstream: retry or inspect connectivity/provider status.
- Unknown: show sanitized provider message without speculative advice.
- Show correlation IDs with source labels.

Do not put request bodies, raw headers/bodies, stack traces, arbitrary provider
objects, or credentials into durable events or the default TUI. Keep redacted
diagnostics on a separate debug surface.

## References

### Local Senpi

- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/modes/app-server/rpc/errors.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/modes/app-server/protocol/terminal.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/core/extensions/builtin/mcp/errors.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/ai/src/utils/error-body.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/ai/src/api/pi-messages.ts`
- `/home/minpeter/github.com/code-yeongyu/senpi/packages/coding-agent/src/core/retry-fallback/log.ts`

### Vercel AI SDK and SDKs

- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/provider/src/errors/api-call-error.ts
- https://github.com/vercel/ai/blob/0643a7dc4becdb7cd3c5b9b6a0a2f74edbbc7970/packages/provider-utils/src/response-handler.ts
- https://ai-sdk.dev/docs/ai-sdk-core/error-handling
- https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error
- https://github.com/openai/openai-node/blob/4ced1a8eaba3f5e960b94090a75e8048f7642439/src/core/error.ts

### Coding agents

- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/llm/src/provider-error.ts
- https://github.com/anomalyco/opencode/blob/62e4641235d7847dadc60da37cca8a023dd54fc1/packages/core/src/v1/session.ts
- https://github.com/openai/codex/blob/205d37a20f742b0bf8e191622bd07c43f567ea49/codex-rs/protocol/src/error.rs
- https://github.com/google-gemini/gemini-cli/blob/87f785192c34067e4e8f26bda16cf9ce24014d83/packages/core/src/utils/errors.ts
- https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/exceptions.py
- https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/util/errorAnalysis.ts

## Contradictions and caveats

- Senpi, OpenCode legacy adapters, Aider, and Continue still use message
  heuristics. Those heuristics are useful only after structured fields are
  unavailable.
- Status alone is also insufficient: provider-specific code/type may refine or
  override status semantics.
- Mid-stream SSE failures may have no HTTP metadata, so `stream` and `unknown`
  are required categories.
- `retryable` is an observation; it must not promise that pss will retry.

## Research method

- Three recursive waves.
- Local source inspection of Senpi/OMO and current pss.
- Official Vercel/OpenAI source and documentation.
- Pinned primary-source comparisons across OpenCode, Codex, Gemini CLI, Aider,
  and Continue.
- Adversarial review for localization, proxies, nested causes, secret leakage,
  and non-HTTP failures.
- Nine claims reached convergence; no unchecked design-changing leads remain.
