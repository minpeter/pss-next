# pss-worker-agent

Based on [minpeter-labs/cf-chat-sdk-worker-template](https://github.com/minpeter-labs/cf-chat-sdk-worker-template).

## Quick start

```bash
cp .dev.vars.example .dev.vars
# fill in .dev.vars (AI_API_KEY, TELEGRAM_*, WORKER_PUBLIC_URL)
# TELEGRAM_WEBHOOK_SECRET_TOKEN: openssl rand -hex 32
pnpm exec wrangler login   # once

pnpm -F "@minpeter/pss-worker-agent" dev    # local
pnpm -F "@minpeter/pss-worker-agent" ship   # deploy
```

After local `dev`, run `ship` again to restore the prod webhook.

## Session transport (RFC 0002)

The initial remote submit-turn RPC is the existing authenticated tRPC mutation:

```text
POST /trpc/tui.turn
Authorization: Bearer <WORKER_AGENT_TUI_TOKEN>
```

Development accepts requests without a token; production requires the configured bearer token. `createRemoteTuiDeliveryClient()` is the supported client for this compatibility surface. It waits for the existing tool-only delivery result, so its response is a delivery result rather than an admission receipt.

The compatibility RPC differs from the implemented generalized transport:

| RFC shape | Initial `tui.turn` shape | Notes |
| --- | --- | --- |
| `SubmitTurnRequest.channel` | `input.channel` | Currently restricted to `{ kind: "tui", id }`. |
| `SubmitTurnRequest.text` | `input.text` | Trimmed and rejected when empty. |
| `SubmitTurnRequest.sessionScopeKey` | `input.sessionScopeKey` | Optional and trimmed before forwarding. |
| `SubmitTurnRequest.idempotencyKey` | Not present | Available on `session.submitTurn`. |
| `SubmitTurnResponse.accepted` | `output.delivered` | Not equivalent: `delivered` reports tool delivery after the run. |
| `SubmitTurnResponse.runId` | Not present | Returned by `session.submitTurn`. |
| `SubmitTurnResponse.threadKey` | Implicit (`default` inside the channel DO) | Runtime naming remains `threadKey`; transport naming remains `session`. |
| `SubmitTurnResponse.eventCursor` | Not present | Clients use durable replay cursors through `session.replayEvents`. |

The route is intentionally retained for compatibility alongside the `session` transport. Telegram continues to use its webhook delivery path.

## Session submit and replay

Authenticated clients can use the generalized tRPC procedures at `/trpc`:

- `session.submitTurn` accepts `{ channel, text, sessionScopeKey?, idempotencyKey? }` and returns immediately after durable admission with `{ accepted: true, runId, threadKey }`.
- `session.replayEvents` accepts `{ channel, after?, limit?, sessionScopeKey? }` and returns committed runtime thread events plus the last `nextCursor` in the page.

Cursor polling through `session.replayEvents` is the baseline reconnect mechanism. Store the latest event cursor, pass it as `after`, and repeat; replay is exclusive of that cursor, so reconnect does not duplicate the last processed event. Replay reads `ThreadHandle.events({ after, limit })` from the runtime's canonical durable thread event history, not a projected `ThreadStore` snapshot.

## Optional SSE stream

Browser-like clients may additionally connect to:

```text
GET /session/events?channel=tui%3Alocal&after=<serialized-cursor>
Authorization: Bearer <WORKER_AGENT_TUI_TOKEN>
Accept: text/event-stream
```

The stream replays committed events after `after` before waiting for newly committed events. Each `thread-event` frame has the serialized cursor as its SSE `id` and a `StoredThreadEvent` JSON object as `data`. `streamRemoteSessionEvents()` reconnects a dropped response with its last received cursor. SSE is an optimization only: clients must retain cursor-polling replay as the deployment-neutral fallback.
