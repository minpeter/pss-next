import type { NotificationRecord, TurnRecord } from "../../../../execution";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import type {
  SqlStorage,
  SqlStorageCursorLike,
} from "../../sql/ports/storage-port";
import type { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";

export const aggregateTables = [
  "pss_thread_input",
  "pss_thread_event",
  "pss_thread_event_meta",
  "pss_payload_chunk",
  "pss_event",
  "pss_event_meta",
  "pss_checkpoint",
  "pss_run",
  "pss_notification",
  "pss_scheduled_work",
  "pss_thread_message",
  "pss_thread_message_chunk",
  "pss_thread_compaction",
  "pss_thread_meta",
] as const;

type AggregateTable = (typeof aggregateTables)[number];

export async function seedThreadAggregate(
  storage: InMemoryDurableObjectStorage,
  sql: SqlStorage,
  prefix: string,
  threadKey: string,
  runId: string,
  suffix: string
): Promise<DurableObjectExecutionStore> {
  const store = new DurableObjectExecutionStore({
    maxPayloadBytes: 180,
    prefix,
    storage,
  });
  const largeText = `${suffix}:${"x".repeat(400)}`;
  await store.threads.commit(
    threadKey,
    {
      state: {
        appliedMigrations: { "workspace/sanitize": 2 },
        compactions: [
          {
            endSeqExclusive: 1,
            schemaVersion: 1,
            startSeq: 0,
            summary: { content: `${suffix} summary`, role: "system" },
          },
        ],
        history: [{ content: largeText, role: "user" }],
        schemaVersion: 3,
      },
    },
    { expectedVersion: null }
  );
  await store.inputs.admit({
    input: { text: largeText, type: "user-input" },
    kind: "send",
    messageId: `input-${suffix}`,
    threadKey,
  });
  await store.threadEvents.append(threadKey, {
    text: largeText,
    type: "assistant-output",
  });
  await store.turns.create(runRecord(runId, { threadKey }));
  await store.events.append(runId, {
    text: largeText,
    type: "assistant-output",
  });
  await store.checkpoints.append(
    {
      checkpointId: `checkpoint-${suffix}`,
      phase: "after-model",
      runId,
      runtimeState: { text: largeText },
      threadSnapshot: { threadKey },
      version: 1,
    },
    { expectedVersion: 0 }
  );
  await store.notifications.enqueue(
    notificationRecord(`notification-${suffix}`, {
      input: { text: largeText, type: "user-input" },
      runId,
      threadKey,
    })
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS pss_scheduled_work (prefix TEXT NOT NULL, kind TEXT NOT NULL, work_id TEXT NOT NULL, payload TEXT NOT NULL, thread_key TEXT, run_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (prefix, kind, work_id))"
  );
  sql.exec(
    "INSERT INTO pss_scheduled_work (prefix, kind, work_id, payload, thread_key, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    prefix,
    "thread-prompt",
    `work-${suffix}`,
    "{}",
    threadKey,
    runId,
    1
  );
  return store;
}

export function rowCounts(sql: SqlStorage): Record<AggregateTable, number> {
  return Object.fromEntries(
    aggregateTables.map((table) => [table, rowCount(sql, table)])
  ) as Record<AggregateTable, number>;
}

export function payloadScopeCounts(sql: SqlStorage): Record<string, number> {
  return Object.fromEntries(
    sql
      .exec<{ readonly count: number; readonly scope: string }>(
        "SELECT scope, COUNT(*) AS count FROM pss_payload_chunk GROUP BY scope"
      )
      .toArray()
      .map((row) => [row.scope, row.count])
  );
}

export function rowCount(sql: SqlStorage, table: string): number {
  return (
    sql
      .exec<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM ${table}`
      )
      .toArray()[0]?.count ?? 0
  );
}

export class TransactionalInMemorySqlStorage implements SqlStorage {
  #failureFragment: string | undefined;
  readonly #storage = new InMemorySqlStorage();

  failNext(queryFragment: string): void {
    this.#failureFragment = queryFragment.toLowerCase();
  }

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T> {
    if (
      this.#failureFragment &&
      query.toLowerCase().includes(this.#failureFragment)
    ) {
      this.#failureFragment = undefined;
      throw new Error("injected SQL failure");
    }
    return this.#storage.exec<T>(query, ...bindings);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#storage.exec("BEGIN");
    try {
      const result = await fn();
      this.#storage.exec("COMMIT");
      return result;
    } catch (error) {
      this.#storage.exec("ROLLBACK");
      throw error;
    }
  }
}

function runRecord(
  runId: string,
  overrides: Partial<TurnRecord> = {}
): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
    ...overrides,
  };
}

function notificationRecord(
  idempotencyKey: string,
  overrides: Partial<NotificationRecord> = {}
): NotificationRecord {
  return {
    idempotencyKey,
    input: { text: "wake up", type: "user-input" },
    notificationId: "notification-1",
    runId: "run-1",
    threadKey: "thread-1",
    status: "pending",
    ...overrides,
  };
}
