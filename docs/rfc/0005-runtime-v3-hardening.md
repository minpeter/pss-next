# RFC 0005: Runtime v3 hardening

- **Status:** Accepted for incremental implementation
- **Date:** 2026-08-30
- **Scope:** `@minpeter/pss-runtime`

## Summary

PSS will not replace its runtime with Effect, actors, a universal service
registry, or one global durable program counter. The durable core, host
contracts, thread snapshots, replay cursors, tool recovery policies, and
Cloudflare/Celld sibling adapters remain.

The almost-v3 program is a correctness-first hardening sequence:

1. unify run claim and lease semantics across every store;
2. add lease-fenced run transitions and checkpoint writes, then settle terminal
   run status, thread state, and durable thread events atomically;
3. add exact-work transactional outbox/reconciliation while wake mechanisms
   remain platform-owned;
4. introduce workflow-local versioned checkpoint payloads;
5. ship RFC 0004 API improvements additively.

The first deliverable implements items 1 and 2. Later waves begin only after
the preceding contracts are green across memory, file, and Durable Object
storage.

## Evidence

Consultation combined four independent views:

- ultrabrain: proposed a total durable run executor;
- Oracle: rejected a wholesale rewrite and found concrete lease defects;
- architect: recommended one package with machine-checked layers;
- skeptic: required failing PSS tests before new abstractions.

Source verification confirmed:

- file storage claims `needs-recovery`, unlike memory and Durable Object;
- file storage can reclaim a `running` run with a live lease;
- blind `TurnStore.update` and checkpoint retries do not fence stale owners;
- state commit and scheduler delivery have an acknowledged crash gap;
- Durable Object storage is correctly neutral across Cloudflare and Celld.

## Decisions

### Keep

- `AgentHost`, `HostStore`, and `HostScheduler`;
- runtime-owned durable thread state and compaction;
- platform-owned wake, timer, fiber, and alarm behavior;
- neutral Durable Object SQL/storage shared by Cloudflare and Celld;
- manual recovery as the default for unclassified tools;
- stable tool idempotency keys;
- committed-only replay with exclusive monotonic cursors;
- application-owned sessions, subagents, extensions, UI, and cleanup;
- one runtime package with curated subpaths.

### Add

#### Shared run lifecycle semantics

One execution module owns:

- claimable statuses;
- terminal statuses;
- live-lease detection;
- the all-status claim decision.

Every first-party store runs the same status/lease contract matrix.
Contract parity alone is not sufficient: memory, file, and Durable Object
implement transitions natively so each check and write runs inside one lock or
storage transaction. The shared fallback is a legacy accommodation only.

#### Lease-fenced transitions

Runtime-owned run mutations use an additive compare-and-set operation:

```ts
type TurnTransitionExpected = {
  checkpointVersion?: number;
  leaseId?: string | null;
  status?: TurnStatus;
};

type TurnTransitionUpdate = {
  lease?: TurnLease | null;
  status: TurnStatus;
};

type TurnTransitionResult =
  | { ok: true; record: TurnRecord }
  | {
      ok: false;
      reason:
        | "not-found"
        | "status-conflict"
        | "lease-conflict"
        | "checkpoint-conflict";
    };
```

The update is deliberately narrow. Callers state the new status and, only when
ownership changes, the new lease. The store carries forward identity,
checkpoint version, and every other field from its current row.

Ownership expectations are explicit. `leaseId: undefined` means no ownership
assertion; `leaseId: null` asserts that the run currently has no lease. Runtime
call sites always pass a string or `null`, so an absent lease cannot silently
downgrade a fenced write into an unfenced one.

Ownership is captured from the write that established it, never from a
follow-up read. Run start uses the successful create or transition result, so a
worker cannot adopt a lease acquired by another worker between those calls.

Rejected transitions surface as typed conflicts carrying the run ID, operation,
and store reason. Callers can distinguish lease, status, and checkpoint
conflicts without parsing error messages.

`leaseUntilMs` is a reclaim deadline, not a hard authority-expiry timestamp.
After that deadline another worker may atomically claim a nonterminal run, but
passing the deadline alone does not revoke the captured lease. The original
owner's writes continue to succeed while its lease ID remains persisted. A
replacement claim first persists a new lease ID and thereby fences the old
owner; a terminal settlement that wins first makes the run unclaimable.

#### Lease-fenced checkpoints

The released `CheckpointStore.append(checkpoint, { expectedVersion })` and
`CheckpointWriteResult` remain unchanged for third-party source compatibility.
Runtime-owned checkpoint writes do not use that legacy port. They require the
distinct optional `HostStore.leaseFencedCheckpoints` capability, whose native
memory, file, and Durable Object implementations compare lease ID, run status,
and checkpoint version in the same transaction as the payload and run-version
write.

A host without the capability fails closed with
`UnsupportedCheckpointFencingError` before legacy `append` is called. There is
no read-then-append fallback because it cannot make the ownership check atomic.
For the file store, standalone legacy and fenced appends enter the generation
transaction; transaction-scoped checkpoint ports stay raw so they do not
recursively open another generation.

File checkpoint reads treat the run record's `checkpointVersion` as authority.
Version zero returns no checkpoint even if legacy orphan files exist, higher
orphan files are ignored, and a positive authoritative version without its
payload is reported as corruption.

#### Atomic terminal settlement

Successful, aborted, and failed turns settle run status, thread state, and
durable terminal/error events inside one host transaction. The transition is
fenced by the lease captured when execution began. A stale owner, thread commit
conflict, or event-log failure rolls the entire settlement back, and buffered
events remain available for recovery rather than being partially consumed.

Nonterminal durable-event flushes use the same captured lease to verify
ownership before appending, while model calls, hooks, observers, and scheduling
remain outside storage transactions.

#### Transactional wake outbox

A later wave stores exact wake intent in the same transaction as run/input
state. Schedulers remain advisory and reconcile durable wake records.

#### Workflow-local checkpoint payloads

The outer checkpoint wire format remains compatible. Each resumable workflow
adds its own versioned discriminated payload parser. Existing phases are never
reinterpreted in place.

#### Additive public vNext

RFC 0004 remains the API roadmap:

- direct `AgentTurn` async iteration;
- `thread.replay()` while retaining `events()` temporarily;
- inspectable thread identity without changing storage encoding;
- async disposal;
- named platform factory options.

### Reject

- a new Effect dependency;
- a global event-sourced continuation model;
- one total program counter spanning unrelated executors;
- runtime-owned structured task scopes over existing descriptive run fields;
- `AgentHost.kind` or a platform enum;
- destructive SQL normalization;
- replay as continuation authority;
- generic exactly-once external-effect claims;
- package fission before measured necessity.

## First increment

### RED contracts

1. A live lease blocks claims for every nonterminal status.
2. `needs-recovery` is not claimable automatically.
3. Memory, file, and Durable Object stores return identical claim reasons.
4. Stale lease owners cannot transition or complete a run.
5. Checkpoint writes reject stale lease owners.

### Implementation

1. Extract shared lifecycle predicates.
2. Make all stores call the shared claim decision.
3. Add optional `TurnStore.transition` plus one `transitionTurn` helper used by
   every runtime call site.
4. Migrate runtime start, completion, cancellation, and checkpoint paths.
5. Route stores without native transition support through the helper's read,
   decide, and update fallback so legacy hosts keep working.
6. Route every in-memory mutation through the same serialized transaction
   queue used by explicit transactions.
7. Decide scheduled-notification retry eligibility in the same transaction
   that schedules the retry and requeues the run.
8. Settle terminal run status, thread state, and durable terminal/error events
   in one lease-fenced host transaction.

### Verification

- shared execution-store contract matrix;
- targeted runtime start/complete/checkpoint tests;
- memory/file/Durable Object package surfaces;
- in-memory isolation proving direct mutations serialize behind transactions;
- retry races proving reclaimed and terminal runs remain untouched;
- terminal-settlement rollback tests for ownership loss and event-log failure;
- manual driver showing file and memory return the same decisions;
- root build, typecheck, test, lint, coverage, boundaries, API, package, and
  Tegami gates.

## Persisted data

The first increment changes no stored wire format or schema. It centralizes
interpretation and adds fenced writes. Existing thread keys, snapshot versions,
event cursors, checkpoint versions, scheduled-work IDs, and adapter prefixes
remain byte-compatible.

Later schema changes must be additive, dual-read/new-write, and independently
verified for file, Cloudflare, and Celld.

## Rollback

The first increment is reversible because it introduces no data migration.
A third-party store that never implements `transition` still works through the
shared helper's read, decide, and update fallback. That path is compare-and-set
but not atomic, so it is a compatibility floor rather than a supported target.
First-party stores may not opt out of native atomic transitions.

## Non-goals

- implementing the full total-state executor in one pull request;
- changing provider billing semantics;
- claiming arbitrary tools execute exactly once;
- moving coding-agent product services into runtime;
- changing Cloudflare or Celld wake ownership;
- removing public API spellings in this increment.
