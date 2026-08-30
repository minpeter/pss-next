import { transitionTurn } from "../../../execution/host/turn-status";
import type {
  CheckpointStore,
  EventStore,
  HostStoreTransaction,
  LeaseFencedCheckpointStore,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../execution/host/types";
import type { ThreadStore } from "../../../thread/store/types";

export type MutationTransaction = Omit<
  HostStoreTransaction,
  "leaseFencedCheckpoints" | "threadEvents" | "turns"
> & {
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore & {
    readonly transition: NonNullable<TurnStore["transition"]>;
  };
};

export type TransactionRunner = <T>(
  mutation: (tx: MutationTransaction) => Promise<T>
) => Promise<T>;

export function serializeCheckpointMutations(
  raw: CheckpointStore & LeaseFencedCheckpointStore,
  run: TransactionRunner
): CheckpointStore & LeaseFencedCheckpointStore {
  return {
    append: async (checkpoint, options) =>
      await run(async (tx) => await tx.checkpoints.append(checkpoint, options)),
    appendFenced: async (checkpoint, options) =>
      await run(
        async (tx) =>
          await tx.leaseFencedCheckpoints.appendFenced(checkpoint, options)
      ),
    latest: async (runId) => await raw.latest(runId),
  };
}

export function serializeEventMutations(
  raw: EventStore,
  run: TransactionRunner
): EventStore {
  return {
    append: async (runId, event) =>
      await run(async (tx) => await tx.events.append(runId, event)),
    read: (runId, cursor) => raw.read(runId, cursor),
  };
}

export function serializeInputMutations(
  run: TransactionRunner
): ThreadInputInbox {
  return {
    ack: async (record) => await run(async (tx) => await tx.inputs.ack(record)),
    admit: async (input) =>
      await run(async (tx) => await tx.inputs.admit(input)),
    claimNext: async (threadKey, boundary, options) =>
      await run(
        async (tx) => await tx.inputs.claimNext(threadKey, boundary, options)
      ),
    markPromoted: async (record) =>
      await run(async (tx) => await tx.inputs.markPromoted(record)),
    recoverClaims: async (threadKey, options) =>
      await run(
        async (tx) => await tx.inputs.recoverClaims(threadKey, options)
      ),
    releaseClaim: async (record) =>
      await run(async (tx) => await tx.inputs.releaseClaim(record)),
  };
}

export function serializeNotificationMutations(
  raw: NotificationInbox,
  run: TransactionRunner
): NotificationInbox {
  return {
    claimByIdempotencyKey: async (idempotencyKey) =>
      await run(
        async (tx) =>
          await tx.notifications.claimByIdempotencyKey(idempotencyKey)
      ),
    enqueue: async (record) =>
      await run(async (tx) => await tx.notifications.enqueue(record)),
    getByIdempotencyKey: async (idempotencyKey) =>
      await raw.getByIdempotencyKey(idempotencyKey),
    releaseByIdempotencyKey: async (idempotencyKey) =>
      await run(
        async (tx) =>
          await tx.notifications.releaseByIdempotencyKey(idempotencyKey)
      ),
  };
}

export function serializeThreadEventMutations(
  raw: ThreadEventLog,
  run: TransactionRunner
): ThreadEventLog {
  return {
    append: async (threadKey, event) =>
      await run(async (tx) => await tx.threadEvents.append(threadKey, event)),
    read: (threadKey, options) => raw.read(threadKey, options),
  };
}

export function serializeThreadMutations(
  raw: ThreadStore,
  run: TransactionRunner
): ThreadStore {
  return {
    commit: async (key, next, options) =>
      await run(async (tx) => await tx.threads.commit(key, next, options)),
    delete: async (key) =>
      await run(async (tx) => await tx.threads.delete(key)),
    load: async (key) => await raw.load(key),
  };
}

export function serializeTurnMutations(
  raw: TurnStore,
  run: TransactionRunner
): TurnStore {
  return {
    claim: async (runId, options) =>
      await run(async (tx) => await tx.turns.claim(runId, options)),
    create: async (record) =>
      await run(async (tx) => await tx.turns.create(record)),
    get: async (runId) => await raw.get(runId),
    getByDedupeKey: async (dedupeKey) => await raw.getByDedupeKey(dedupeKey),
    listByParentRunId: async (parentRunId) =>
      await raw.listByParentRunId(parentRunId),
    transition: async (runId, expected, update) =>
      await run(
        async (tx) =>
          await transitionTurn(tx.turns, { expected, runId, update })
      ),
    update: async (record) =>
      await run(async (tx) => await tx.turns.update(record)),
  };
}
