import type {
  CheckpointStore,
  EventStore,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../execution/host/types";
import type { ThreadStore } from "../../thread/store/types";

/**
 * Database boundary for the SQL/queue host.
 *
 * Implementations normally bind these ports to a connection pool and pass a
 * transaction-scoped set of ports to `transaction`. The callback must commit
 * atomically on success and roll back on rejection.
 */
export interface SqlHostStorePort {
  readonly checkpoints: CheckpointStore;
  deleteThread?(threadKey: string): Promise<void>;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly notifications: NotificationInbox;
  readonly threadEvents?: ThreadEventLog;
  readonly threads: ThreadStore;
  transaction<T>(fn: (tx: HostStoreTransaction) => Promise<T>): Promise<T>;
  readonly turns: TurnStore;
}

/** Adapts a database implementation to the runtime's stable HostStore API. */
export class SqlHostStore implements HostStore {
  readonly #port: SqlHostStorePort;
  readonly deleteThread: HostStore["deleteThread"];

  constructor(port: SqlHostStorePort) {
    this.#port = port;
    this.deleteThread = port.deleteThread?.bind(port);
  }

  get checkpoints(): CheckpointStore {
    return this.#port.checkpoints;
  }

  get events(): EventStore {
    return this.#port.events;
  }

  get inputs(): ThreadInputInbox {
    return this.#port.inputs;
  }

  get notifications(): NotificationInbox {
    return this.#port.notifications;
  }

  get threadEvents(): ThreadEventLog | undefined {
    return this.#port.threadEvents;
  }

  get threads(): ThreadStore {
    return this.#port.threads;
  }

  get turns(): TurnStore {
    return this.#port.turns;
  }

  transaction<T>(fn: (tx: HostStoreTransaction) => Promise<T>): Promise<T> {
    return this.#port.transaction(fn);
  }
}
