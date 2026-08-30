import type {
  CheckpointStore,
  EventStore,
  HostStore,
  HostStoreTransaction,
  LeaseFencedCheckpointStore,
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
import { InMemoryCheckpointStore } from "./checkpoint-store";
import { InMemoryEventStore, InMemoryThreadEventLog } from "./event-stores";
import { InMemoryThreadInputInbox } from "./inputs";
import { InMemoryNotificationInbox } from "./notifications";
import { InMemoryRunStore } from "./runs";
import {
  type MutationTransaction,
  serializeCheckpointMutations,
  serializeEventMutations,
  serializeInputMutations,
  serializeNotificationMutations,
  serializeThreadEventMutations,
  serializeThreadMutations,
  serializeTurnMutations,
} from "./serialized-ports";
import type { ExecutionState } from "./state";
import { cloneState, createEmptyState } from "./state";

export class InMemoryExecutionStore implements HostStore {
  #state = createEmptyState();
  #transactionChain: Promise<void> = Promise.resolve();
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
  readonly notifications: NotificationInbox;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;

  constructor() {
    const state = () => this.#state;
    const run = async <T>(mutation: (tx: MutationTransaction) => Promise<T>) =>
      await this.#enqueue(mutation);
    const checkpoints = serializeCheckpointMutations(
      new InMemoryCheckpointStore(state),
      run
    );
    this.checkpoints = checkpoints;
    this.leaseFencedCheckpoints = checkpoints;
    this.events = serializeEventMutations(new InMemoryEventStore(state), run);
    this.inputs = serializeInputMutations(run);
    this.notifications = serializeNotificationMutations(
      new InMemoryNotificationInbox(state),
      run
    );
    this.threadEvents = serializeThreadEventMutations(
      new InMemoryThreadEventLog(state),
      run
    );
    this.turns = serializeTurnMutations(new InMemoryRunStore(state), run);
    this.threads = serializeThreadMutations(
      new InMemoryExecutionThreadStore(state),
      run
    );
  }
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
    return await this.#enqueue(async (tx) => await fn(tx));
  }

  async #enqueue<T>(
    mutation: (tx: MutationTransaction) => Promise<T>
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
      const result = await mutation(transactionStore);
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
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
  readonly notifications: NotificationInbox;
  readonly threadEvents: ThreadEventLog;
  readonly turns: InMemoryRunStore;
  readonly threads: ThreadStore;
  readonly #state: ExecutionState;

  constructor(state: ExecutionState) {
    this.#state = state;
    const checkpoints = new InMemoryCheckpointStore(() => this.#state);
    this.checkpoints = checkpoints;
    this.leaseFencedCheckpoints = checkpoints;
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
