import type {
  Checkpoint,
  CheckpointStore,
  CheckpointWriteResult,
  EventStore,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../execution/host/types";
import type {
  CommitResult,
  ExpectedThreadVersion,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../../thread/store/types";
import { InMemoryEventStore, InMemoryThreadEventLog } from "./event-stores";
import { InMemoryThreadInputInbox } from "./inputs";
import { InMemoryNotificationInbox } from "./notifications";
import { InMemoryRunStore } from "./runs";
import type { ExecutionState } from "./state";
import { cloneState, createEmptyState } from "./state";

export class InMemoryExecutionStore implements HostStore {
  #state = createEmptyState();
  #transactionChain: Promise<void> = Promise.resolve();
  readonly checkpoints: CheckpointStore = new InMemoryCheckpointStore(
    () => this.#state
  );
  readonly events: EventStore = new InMemoryEventStore(() => this.#state);
  readonly inputs: ThreadInputInbox = {
    ack: async (record) =>
      await this.transaction(async (tx) => await tx.inputs.ack(record)),
    admit: async (input) =>
      await this.transaction(async (tx) => await tx.inputs.admit(input)),
    claimNext: async (threadKey, boundary, options) =>
      await this.transaction(
        async (tx) => await tx.inputs.claimNext(threadKey, boundary, options)
      ),
    markPromoted: async (record) =>
      await this.transaction(
        async (tx) => await tx.inputs.markPromoted(record)
      ),
    recoverClaims: async (threadKey, options) =>
      await this.transaction(
        async (tx) => await tx.inputs.recoverClaims(threadKey, options)
      ),
    releaseClaim: async (record) =>
      await this.transaction(
        async (tx) => await tx.inputs.releaseClaim(record)
      ),
  };
  readonly notifications: NotificationInbox = new InMemoryNotificationInbox(
    () => this.#state
  );
  readonly threadEvents: ThreadEventLog = new InMemoryThreadEventLog(
    () => this.#state
  );
  readonly turns: TurnStore = new InMemoryRunStore(() => this.#state);
  readonly threads: ThreadStore = new InMemoryExecutionThreadStore(
    () => this.#state
  );
  get sessions(): ThreadStore {
    return this.threads;
  }

  async deleteThread(threadKey: string): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.deleteThread?.(threadKey);
    });
  }

  async transaction<T>(
    fn: (tx: HostStoreTransaction) => Promise<T>
  ): Promise<T> {
    const previousTransaction = this.#transactionChain;
    let releaseTransaction: () => void = () => undefined;
    this.#transactionChain = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    await previousTransaction;
    const transactionState = cloneState(this.#state);
    const transactionStore = new InMemoryTransactionStore(transactionState);
    try {
      const result = await fn(transactionStore);
      this.#state = transactionState;
      return result;
    } finally {
      releaseTransaction();
    }
  }
}

class InMemoryTransactionStore implements HostStoreTransaction {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly notifications: NotificationInbox;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;
  readonly #state: ExecutionState;

  constructor(state: ExecutionState) {
    this.#state = state;
    this.checkpoints = new InMemoryCheckpointStore(() => this.#state);
    this.events = new InMemoryEventStore(() => this.#state);
    this.inputs = new InMemoryThreadInputInbox(() => this.#state);
    this.notifications = new InMemoryNotificationInbox(() => this.#state);
    this.threadEvents = new InMemoryThreadEventLog(() => this.#state);
    this.turns = new InMemoryRunStore(() => this.#state);
    this.threads = new InMemoryExecutionThreadStore(() => this.#state);
  }

  get sessions(): ThreadStore {
    return this.threads;
  }

  deleteThread(threadKey: string): Promise<void> {
    deleteThreadFromState(this.#state, threadKey);
    return Promise.resolve();
  }
}

function deleteThreadFromState(state: ExecutionState, threadKey: string): void {
  const runIds = [...state.turns.values()]
    .filter((turn) => turn.threadKey === threadKey)
    .map((turn) => turn.runId);
  const runIdSet = new Set(runIds);
  state.inputsByThread.delete(threadKey);
  state.threadEvents.delete(threadKey);
  state.threads.delete(threadKey);
  state.threadVersions.delete(threadKey);
  for (const runId of runIds) {
    state.turns.delete(runId);
    state.events.delete(runId);
    state.checkpoints.delete(runId);
  }
  for (const [key, notification] of state.notificationsByKey) {
    if (
      notification.threadKey === threadKey ||
      runIdSet.has(notification.runId)
    ) {
      state.notificationsByKey.delete(key);
    }
  }
}

class InMemoryExecutionThreadStore implements ThreadStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  commit(
    key: string,
    next: ThreadStoreCommit,
    options: { readonly expectedVersion: ExpectedThreadVersion }
  ): Promise<CommitResult> {
    const state = this.#state();
    const current = state.threads.get(key);
    const currentVersion = current?.version ?? null;

    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const versionNumber = (state.threadVersions.get(key) ?? 0) + 1;
    const version = String(versionNumber);
    state.threadVersions.set(key, versionNumber);
    state.threads.set(key, structuredClone({ state: next.state, version }));
    return Promise.resolve({ ok: true, version });
  }

  delete(key: string): Promise<void> {
    const state = this.#state();
    state.threads.delete(key);
    state.threadVersions.delete(key);
    return Promise.resolve();
  }

  load(key: string): Promise<StoredThread | null> {
    const stored = this.#state().threads.get(key);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }
}

class InMemoryCheckpointStore implements CheckpointStore {
  readonly #state: () => ExecutionState;

  constructor(state: () => ExecutionState) {
    this.#state = state;
  }

  append(
    checkpoint: Checkpoint,
    options: {
      readonly expectedLeaseId?: string | null;
      readonly expectedVersion: number;
    }
  ): Promise<CheckpointWriteResult> {
    const run = this.#state().turns.get(checkpoint.runId);
    if (
      options.expectedLeaseId !== undefined &&
      (run?.lease?.leaseId ?? null) !== options.expectedLeaseId
    ) {
      return Promise.resolve({ ok: false, reason: "lease-conflict" });
    }
    const currentVersion = run?.checkpointVersion ?? 0;
    if (currentVersion !== options.expectedVersion) {
      return Promise.resolve({
        currentVersion,
        ok: false,
        reason: "stale-version",
      });
    }

    const stored = structuredClone(checkpoint);
    const checkpoints = this.#state().checkpoints.get(checkpoint.runId) ?? [];
    checkpoints.push(stored);
    this.#state().checkpoints.set(checkpoint.runId, checkpoints);
    if (run) {
      this.#state().turns.set(checkpoint.runId, {
        ...run,
        checkpointVersion: checkpoint.version,
      });
    }

    return Promise.resolve({ ok: true, version: checkpoint.version });
  }

  latest(runId: string): Promise<Checkpoint | null> {
    const checkpoints = this.#state().checkpoints.get(runId) ?? [];
    const checkpoint = checkpoints.at(-1);
    return Promise.resolve(checkpoint ? structuredClone(checkpoint) : null);
  }
}
