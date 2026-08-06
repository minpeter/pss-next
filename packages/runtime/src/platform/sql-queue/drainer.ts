import type { SqlQueueClaim, SqlQueuePort, SqlQueueWork } from "./queue";

export interface SqlQueueDrainOptions {
  readonly clock?: () => number;
  readonly handle: (work: SqlQueueWork, claim: SqlQueueClaim) => Promise<void>;
  readonly leaseMs?: number;
  readonly limit?: number;
  readonly queue: SqlQueuePort;
  readonly retryDelayMs?: number | ((attempt: number) => number);
}

export interface SqlQueueDrainResult {
  readonly claimed: number;
  readonly failed: number;
  readonly succeeded: number;
}

/**
 * Claims due work and acknowledges only successful handlers. Failed handlers
 * are nacked with a retry time; a nack failure is surfaced so the lease can
 * expire and another worker can safely reclaim the item.
 */
export async function drainSqlQueue({
  clock = Date.now,
  handle,
  leaseMs = 30_000,
  limit = 100,
  queue,
  retryDelayMs = 1000,
}: SqlQueueDrainOptions): Promise<SqlQueueDrainResult> {
  let claimed = 0;
  let failed = 0;
  let succeeded = 0;
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const normalizedLeaseMs = Math.max(1, Math.floor(leaseMs));

  while (claimed < normalizedLimit) {
    const claim = await queue.claim({
      leaseMs: normalizedLeaseMs,
      nowMs: clock(),
    });
    if (!claim) {
      break;
    }
    claimed += 1;
    try {
      await handle(claim.work, claim);
      await queue.ack(claim);
      succeeded += 1;
    } catch {
      const configuredDelay =
        typeof retryDelayMs === "function"
          ? retryDelayMs(claim.attempt)
          : retryDelayMs;
      await queue.nack(claim, {
        retryAtMs: clock() + Math.max(0, Math.floor(configuredDelay)),
      });
      failed += 1;
    }
  }

  return { claimed, failed, succeeded };
}
