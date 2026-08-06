import type { SqlQueueProducerPort, SqlQueueRunWork } from "./queue";

export interface SqlQueuedRunCandidate {
  readonly dueAtMs?: number;
  readonly runId: string;
}

/** Database query boundary for durable runs which should have queue work. */
export interface SqlQueuedRunSource {
  listQueuedRuns(): AsyncIterable<SqlQueuedRunCandidate>;
}

export interface SqlQueueReconciliationOptions {
  readonly clock?: () => number;
  readonly queue: SqlQueueProducerPort;
  readonly runs: SqlQueuedRunSource;
  readonly wake?: (dueAtMs: number) => Promise<void> | void;
}

export interface SqlQueueReconciliationResult {
  readonly enqueued: number;
}

/**
 * Idempotently recreates queue work for durable queued runs.
 *
 * Run this periodically to close the crash gap between a committed HostStore
 * transaction and scheduling. The source should query all runnable queued
 * turns; unique work IDs make replay safe even when work already exists.
 */
export async function reconcileSqlQueuedRuns({
  clock = Date.now,
  queue,
  runs,
  wake,
}: SqlQueueReconciliationOptions): Promise<SqlQueueReconciliationResult> {
  let enqueued = 0;
  for await (const candidate of runs.listQueuedRuns()) {
    const work: SqlQueueRunWork = {
      dueAtMs: candidate.dueAtMs ?? clock(),
      kind: "run",
      runId: candidate.runId,
      workId: `run:${candidate.runId}`,
    };
    await queue.enqueue(work);
    await wake?.(work.dueAtMs);
    enqueued += 1;
  }
  return { enqueued };
}
