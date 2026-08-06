import type { SqlQueueProducerPort, SqlQueueWork } from "./queue";

/**
 * Database/outbox query boundary for exact durable work which should exist in
 * the queue. Sources must preserve the original kind, payload, due time, and
 * stable work ID; a run record alone is insufficient for thread prompts.
 */
export interface SqlQueuedWorkSource {
  listQueuedWork(): AsyncIterable<SqlQueueWork>;
}

export interface SqlQueueReconciliationOptions {
  readonly queue: SqlQueueProducerPort;
  readonly source: SqlQueuedWorkSource;
  readonly wake?: (dueAtMs: number) => Promise<void> | void;
}

export interface SqlQueueReconciliationResult {
  readonly enqueued: number;
}

/**
 * Idempotently restores exact queue work from a durable source or outbox.
 *
 * Run this periodically to close the crash gap between a committed HostStore
 * transaction and scheduling. Stable work IDs make replay safe when an item
 * already exists or concurrent reconcilers race.
 */
export async function reconcileSqlQueuedWork({
  queue,
  source,
  wake,
}: SqlQueueReconciliationOptions): Promise<SqlQueueReconciliationResult> {
  let enqueued = 0;
  for await (const work of source.listQueuedWork()) {
    await queue.enqueue(work);
    await wake?.(work.dueAtMs);
    enqueued += 1;
  }
  return { enqueued };
}
