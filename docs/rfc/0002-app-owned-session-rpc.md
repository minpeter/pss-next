---
source_issue: 172
source_url: https://github.com/minpeter/pss-runtime/issues/172
original_created_at: 2026-07-07
status: Implemented
---

> Moved from GitHub issue #172 into the repo on 2026-07-19; the issue is closed and this file is the canonical copy.

# RFC 0002: App-Owned Session RPC and Streaming Transport

| Field | Value |
|-------|-------|
| **Status** | Implemented |
| **Authors** | @minpeter |
| **Created** | 2026-07-07 |
| **Target packages** | `apps/worker-agent`, optionally examples/docs in `@minpeter/pss-runtime` |
| **Depends on** | RFC 0001 durable thread event replay for reconnect-safe streaming |

---

## Summary

RFC 0001 keeps HTTP/SSE session APIs out of `@minpeter/pss-runtime` because runtime core should stay an embed kernel, not a hosted agent server.

This RFC defines the separate app-owned transport layer: a session RPC surface for submitting turns, reading/replaying events, and optionally streaming live events over SSE/WebSocket-like transports.

The key design split:

- `@minpeter/pss-runtime` owns durable primitives: `Agent`, `ThreadHandle`, `turn.events()`, durable inbox, thread event replay.
- `worker-agent` owns HTTP/RPC/SSE transport, auth, channel/session mapping, and client UX contracts.

---

## Current State

`apps/worker-agent` implements the app-owned transport while keeping transport
concerns out of runtime core:

- `session.submitTurn` durably admits an input and returns `runId` and
  `threadKey`; an optional idempotency key makes admission retry-safe.
- `session.replayEvents` reads committed `StoredThreadEvent` records after an
  exclusive cursor from `ThreadHandle.events()`.
- `GET /session/events` replays the same durable records and then follows newly
  committed events over SSE; the remote client reconnects with its last cursor.
- Auth, `ChannelAddress` routing, and `sessionScopeKey` remain worker-owned.
- The older `tui.turn` delivery-result RPC remains as a compatibility surface.

Polling `session.replayEvents` is the portable baseline. SSE is optional and
never the only recovery path. See `apps/worker-agent/README.md` for request and
reconnect details.

## Goals

- Keep HTTP/SSE/RPC out of runtime core.
- Standardize app-owned session transport in `worker-agent`.
- Support submit-turn, replay-events, and optional live-stream workflows.
- Reuse RFC 0001 durable input inbox and thread event replay once available.
- Keep auth and session/channel mapping app-owned.
- Keep Telegram, TUI, and future browser clients on one transport model where practical.

## Non-Goals

- Adding HTTP/SSE APIs to `@minpeter/pss-runtime` core.
- Replacing `turn.events()` as the runtime live driver.
- Making event replay the continuation source of truth.
- Adding OpenCode-style Location, filesystem, skills, or permission policy.
- Defining a full public SaaS API.

---

## Proposed Transport Surface

### 1. Submit Turn

Submit user input to a session/channel.

```ts
interface SubmitTurnRequest {
  readonly channel: ChannelAddress;
  readonly text: string;
  readonly sessionScopeKey?: string;
  readonly idempotencyKey?: string;
}

interface SubmitTurnResponse {
  readonly accepted: true;
  readonly runId?: string;
  readonly threadKey: string;
  readonly eventCursor?: ThreadEventCursor;
}
```

Initial implementation can keep the existing `tui.turn` mutation, then generalize naming once multiple clients share it.

### 2. Replay Events

Read durable events after a cursor.

```ts
interface ReplayEventsRequest {
  readonly channel: ChannelAddress;
  readonly after?: ThreadEventCursor;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}

interface ReplayEventsResponse {
  readonly events: readonly StoredThreadEvent[];
  readonly nextCursor?: ThreadEventCursor;
}
```

This should be backed by RFC 0001 `thread.events({ after, limit })`, not by projecting `ThreadStore` snapshots.

### 3. Live Event Stream

Optional live stream for UI clients.

Transport choices:

- SSE for browser-friendly server-to-client event streams.
- tRPC subscription/WebSocket only if the deployment target and client UX justify it.
- Plain polling replay as the fallback baseline.

SSE shape:

```text
GET /session/events?channel=...&after=...
Authorization: Bearer <token>
```

The server should first replay durable events after the cursor, then stream new committed events as they arrive when supported. If the live stream drops, the client reconnects with the last durable cursor.

---

## Architecture

```text
client
  ├── submitTurn RPC
  ├── replayEvents RPC
  └── optional SSE live stream

worker-agent transport
  ├── auth / token checks
  ├── ChannelAddress -> Durable Object name
  ├── sessionScopeKey filtering
  ├── submit input to Agent Durable Object
  └── read thread event replay from runtime-backed host

@minpeter/pss-runtime
  ├── durable input inbox (RFC 0001)
  ├── thread.events({ after }) durable replay (RFC 0001)
  └── turn.events() live driver, unchanged
```

---

## Implementation Status

| Phase | Result | Gate |
|-------|--------|------|
| 1 | Existing `/trpc/tui.turn` retained and documented as compatibility RPC | remote TUI tests |
| 2 | Shared request, response, channel, and cursor schemas | session contract tests |
| 3 | `session.submitTurn` and `session.replayEvents` backed by durable admission/replay | idempotency and cursor replay tests |
| 4 | Optional `/session/events` SSE replay/follow endpoint | reconnect and dropped-response tests |
| 5 | Remote session client exposes submit, polling replay, and SSE helpers | remote client tests |

## Resolved Decisions

1. tRPC is the typed submit/replay baseline; SSE is a separate HTTP endpoint.
2. Cursor polling is required as the deployment-neutral recovery path; SSE is
   optional.
3. `session.submitTurn` returns after durable admission. The legacy `tui.turn`
   continues to wait for its delivery result.
4. Telegram remains webhook-delivery-owned rather than consuming session replay.
5. Runtime naming remains `thread`; the app transport uses `session` and maps a
   `ChannelAddress` to its Durable Object.

## References

- RFC 0001: https://github.com/minpeter/pss-next/issues/171
- Existing worker entrypoint: `apps/worker-agent/src/index.ts`
- Existing tRPC router: `apps/worker-agent/src/rpc/worker-rpc.ts`
- Existing TUI dispatch: `apps/worker-agent/src/tui/tui-server.ts`
- Existing remote TUI client: `apps/worker-agent/src/tui/tui-remote.ts`
- Existing Durable Object request parser: `apps/worker-agent/src/agent/agent-do-request.ts`
