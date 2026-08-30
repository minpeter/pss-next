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
2. add lease-fenced run transitions and checkpoint writes;
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

#### Lease-fenced transitions

Runtime-owned run mutations use an additive compare-and-set operation:

```ts
type TurnTransitionExpected = {
  status?: TurnStatus;
  leaseOwnerId?: string;
  checkpointVersion?: number;
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

Stores must reject stale workers instead of allowing them to adopt a newer
checkpoint version or overwrite a newer terminal state.

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
3. Add `TurnStore.transition`.
4. Migrate runtime start, completion, cancellation, and checkpoint paths.
5. Keep `TurnStore.update` only as a compatibility seam until all internal
   callers migrate.

### Verification

- shared execution-store contract matrix;
- targeted runtime start/complete/checkpoint tests;
- memory/file/Durable Object package surfaces;
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
If fenced transitions expose a legacy third-party store deficiency, that host
continues using the deprecated update seam until it passes the conformance
suite; first-party stores may not opt out.

## Non-goals

- implementing the full total-state executor in one pull request;
- changing provider billing semantics;
- claiming arbitrary tools execute exactly once;
- moving coding-agent product services into runtime;
- changing Cloudflare or Celld wake ownership;
- removing public API spellings in this increment.
