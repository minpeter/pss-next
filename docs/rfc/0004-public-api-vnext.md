# RFC 0004: Public API vNext

**Status**: Proposed

**Scope**: `@minpeter/pss-runtime`, `@minpeter/pss-coding-agent/extension`

**Compatibility**: This RFC and its snapshot gate do not change the current API.
The proposed removals and renames require a future major release.

## Summary

Public API vNext makes the live-turn, durable-replay, and resource-lifecycle
contracts unambiguous. It also makes package entrypoints the ownership boundary:
core concepts stay on the runtime root, host implementations stay on platform
subpaths, and application extension composition stays in coding-agent.

This document is the decision target for future implementation PRs. A committed
snapshot of every published runtime entrypoint makes any interim public-surface
change an explicit, reviewable diff.

## Goals

- Give live turn iteration and durable replay distinct names and semantics.
- Provide inspectable, stable thread identity.
- Separate durable deletion from local handle disposal.
- Keep the root entrypoint small and runtime-neutral.
- Normalize platform construction without hiding platform capabilities.
- Preserve the runtime-hook/coding-agent-extension ownership decision.

## Non-goals

- Changing behavior in the RFC PR.
- Designing HTTP, RPC, or SSE application protocols.
- Making replay the source of truth for execution continuation.
- Adding extension discovery, dependency resolution, or hot reload.

## Proposed surface

### 1. Turn iteration

`AgentTurn` becomes directly async iterable and remains single-consumer:

```ts
interface AgentTurn extends AsyncIterable<AgentEvent> {
  readonly runId?: string;
}

const turn = await thread.send(input);
for await (const event of turn) {
  // drives this live execution
}
```

`turn.events()` is deprecated during the compatibility window and delegates to
`turn[Symbol.asyncIterator]()`. Calling either form after iteration has started
throws. Concurrent `next()` calls remain unsupported. Ending iteration early
cancels consumption of the live turn but does not mean "delete the thread".
Errors from execution reject the iterator.

**Decision:** the noun `events` is not used as a method for both live and
persisted data. Direct iteration is always the live turn returned by a command.

### 2. Durable replay naming

Durable history is named `replay`:

```ts
interface ThreadHandle {
  replay(options?: ThreadReplayOptions): AsyncIterable<StoredThreadEvent>;
}

interface ThreadReplayOptions {
  readonly after?: ThreadEventCursor;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}
```

`thread.events(options)` is deprecated in favor of `thread.replay(options)`.
Replay reads committed events only, is repeatable, and never drives a turn.
`after` is exclusive. Items are ordered by cursor; callers persist the last
observed cursor and may safely resume after it. A storage backend that cannot
replay throws `ThreadEventReplayUnsupportedError` before yielding an item.

This RFC does not promise a tailing/live replay mode. Applications combine a
bounded replay endpoint with their own polling or transport.

### 3. Thread identity

Identity is immutable and visible on every handle:

```ts
type ThreadId = string;

interface ThreadIdentity {
  readonly id: ThreadId;
  readonly scope?: string;
}

interface ThreadHandle {
  readonly identity: ThreadIdentity;
}

interface Agent {
  // Final vNext signature after the compatibility window.
  thread(identity: ThreadId | ThreadIdentity): ThreadHandle;
}
```

`id` replaces the ambiguous public word `key`. Scope participates in storage
identity; metadata does not. The runtime canonicalizes the pair for storage but
does not expose the encoded storage key as identity. Two inputs with the same
`id` and `scope` identify the same durable thread.

The additive/deprecation phase temporarily uses
`thread(identity: ThreadId | ThreadIdentity | ThreadAddress)`. In that overload,
`ThreadAddress.key` maps to `ThreadIdentity.id` and its `metadata` remains
non-identifying compatibility data. The major release removes `ThreadAddress`
from this input, leaving the final signature shown above. `threadStoreKey`
leaves the root because it is an encoding helper rather than identity.

### 4. Delete and dispose

The two lifecycle operations have deliberately different effects:

```ts
interface ThreadHandle extends AsyncDisposable {
  delete(options?: { signal?: AbortSignal }): Promise<void>;
  dispose(): Promise<void>;
}

interface Agent extends AsyncDisposable {
  dispose(): Promise<void>;
}
```

- `thread.delete()` is a durable, idempotent data operation. It interrupts work,
  deletes persisted thread state and events according to host policy, disposes
  the local handle, and makes that handle unusable. A later `agent.thread()` may
  create a fresh thread with the same identity.
- `thread.dispose()` only releases/evicts the process-local handle and interrupts
  work owned by it. It never deletes persisted state.
- `agent.dispose()` disposes all local handles and agent-owned resources. It
  never bulk-deletes durable threads.
- `Symbol.asyncDispose` delegates to `dispose`, never to `delete`.

After disposal, command and replay methods throw a single exported
`DisposedResourceError`. Repeated `dispose()` calls succeed. Delete failures are
reported; they must not be silently converted into local-only disposal.

### 5. Root and subpath curation

The package export map is closed: consumers may import only declared subpaths.
The vNext ownership rule is:

| Entrypoint | Owns |
| --- | --- |
| `@minpeter/pss-runtime` | `Agent`, thread/turn/input/event contracts, hooks, diagnostics, model-context and compaction policy |
| `/execution` | durable host/store/scheduler contracts and inspection |
| `/platform/memory` | in-memory host and stores |
| `/platform/file` | Node file host, stores, scheduler and options |
| `/platform/cloudflare` | Workers/Agents host adapters and scheduling |
| `/platform/cloudflare/image-codecs` | edge-only codec installation |
| `/otel` | OpenTelemetry adapter |
| `/channel` | channel projection contracts |
| `/fsm`, `/namespace`, `/evals`, `/testing` | their named specialist surfaces |

Platform implementations and storage encoding helpers must not be re-exported
from root. Root may reference `/execution` types where required by `Agent`, but
convenience re-exports do not expand the root. New subpaths require an RFC or an
explicit public-API rationale in the PR.

### 6. Platform options

All host factories use one-argument, named option objects and the suffix
`Options`:

```ts
createInMemoryHost(options?: InMemoryHostOptions): AgentHost;
createFileHost(options: FileHostOptions): AgentHost;
createCloudflareHost(options: CloudflareHostOptions): AgentHost;
```

Common option names have common meaning:

- `diagnostics`: runtime diagnostics sink;
- `attachmentStore`: explicit attachment override;
- `scheduler`: scheduling capability override;
- `clock`: injectable clock where supported;
- `namespace`: host-level storage namespace, not thread identity scope.

Platform-only bindings remain platform-specific and required where necessary.
Factories return the narrow `AgentHost`; platform-specific management handles
are exposed by explicitly named platform APIs, not extra root fields. Existing
factory signatures remain until their individual deprecation/migration PRs.

### 7. Extension API

RFC 0003 remains authoritative. Runtime exposes one atomic `AgentHooks` object;
it does not expose extension identity, discovery, ordering, UI, commands, or
cleanup. `@minpeter/pss-coding-agent/extension` owns `CodingAgentExtension`, its
registry, composition, activation, and reverse-order disposal.

The stable application-extension lifecycle is:

```text
configure (registration only, in order)
  -> close registration
  -> compose hooks/tools/instructions
  -> create Agent
  -> activate
  -> run
  -> dispose Agent
  -> dispose extensions (reverse order)
```

Extensions must have stable IDs. Contributions are rejected after configure.
Activation may return one async disposer. Runtime hook errors retain extension
attribution supplied by the coding-agent composer, without runtime learning an
extension registry. The extension subpath is versioned with
`@minpeter/pss-coding-agent`, not runtime.

## Compatibility and rollout

1. **Now:** freeze the actual declarations with the public-surface snapshot.
2. **Additive phase:** add direct turn iteration, `replay`, `identity`, normalized
   options, async disposal, and documented error semantics while retaining old
   spellings.
3. **Deprecation phase:** mark `turn.events()`, `thread.events()`, address `key`,
   and root encoding helpers deprecated; publish migration examples.
4. **Major release:** remove deprecated spellings and apply final root curation.

Each implementation PR updates the snapshot only after reviewing its `+`/`-`
diff. Additive snapshot changes still require API review; the gate is not only
a breaking-change detector.

## Automated public-surface gate

`packages/runtime/public-api.snapshot.json` records every exported name as an explicit type-only export or a verified runtime
value export for every `package.json#exports` entrypoint. CI builds runtime,
then runs `pnpm api:check`. The command prints a deterministic per-entrypoint
diff and fails on added, removed, moved, or type-only/value export changes.

After an intentional change:

```sh
pnpm api:update
pnpm api:check
```

The snapshot intentionally covers names and entrypoint placement, not structural
TypeScript compatibility. Behavioral/structural changes still require contract
tests and review. The pre-existing release-artifact checks continue to catch
forbidden leaks and packaging errors.

## Acceptance criteria for vNext

- Live turns are directly iterable and durable history uses `replay`.
- Thread handles expose immutable identity; storage encoding is not identity.
- Delete/dispose behavior is tested across memory, file, and Cloudflare hosts.
- Root contains no platform implementation exports.
- Every platform factory follows the named-options convention.
- Runtime hooks and coding-agent extensions retain the RFC 0003 boundary.
- Migration documentation exists before deprecated names are removed.

## Open questions

- Whether `ThreadId` should be a branded string is deferred; branding must not
  change serialized identity.
- Durable event retention and delete tombstones remain host policy and need a
  separate storage RFC.
- Exact major version and deprecation duration depend on adoption data.
