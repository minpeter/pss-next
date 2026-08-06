import type { SqlQueueClaim, SqlQueuePort, SqlQueueWork } from "./queue";

export interface SqlQueueHandlerErrorContext {
  readonly claim: SqlQueueClaim;
  readonly error: unknown;
  readonly work: SqlQueueWork;
}

export interface SqlQueueDrainOptions {
  readonly clock?: () => number;
  readonly handle: (work: SqlQueueWork, claim: SqlQueueClaim) => Promise<void>;
  readonly heartbeatMs?: number;
  readonly leaseMs?: number;
  readonly limit?: number;
  /** Observes handler failures after the work has been safely nacked. */
  readonly onError?: (
    context: SqlQueueHandlerErrorContext
  ) => Promise<void> | void;
  readonly queue: SqlQueuePort;
  readonly retryDelayMs?: number | ((attempt: number) => number);
}

export interface SqlQueueDrainResult {
  readonly claimed: number;
  readonly failed: number;
  readonly succeeded: number;
}

type HandlerOutcome =
  | { readonly claim: SqlQueueClaim; readonly ok: true }
  | {
      readonly claim: SqlQueueClaim;
      readonly error: unknown;
      readonly ok: false;
    };

/**
 * Claims due work, renews its fenced lease during handling, and acknowledges
 * only successful handlers. Handler failures are nacked for retry and exposed
 * through `onError`. Ack and renewal failures surface without nack because
 * their outcome or claim ownership is uncertain; lease expiry enables retry.
 * A lost renewal cannot cancel an already-running handler, so handlers must be
 * idempotent and tolerate concurrent duplicate execution (at-least-once).
 */
export async function drainSqlQueue({
  clock = Date.now,
  handle,
  heartbeatMs,
  leaseMs = 30_000,
  limit = 100,
  onError,
  queue,
  retryDelayMs = 1000,
}: SqlQueueDrainOptions): Promise<SqlQueueDrainResult> {
  let claimed = 0;
  let failed = 0;
  let succeeded = 0;
  const seenWorkIds = new Set<string>();
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const normalizedLeaseMs = Math.max(1, Math.floor(leaseMs));
  const normalizedHeartbeatMs = Math.max(
    1,
    Math.min(
      Math.floor(heartbeatMs ?? normalizedLeaseMs / 3),
      Math.max(1, Math.floor(normalizedLeaseMs / 2))
    )
  );

  while (claimed < normalizedLimit) {
    const claim = await queue.claim({
      excludeWorkIds: [...seenWorkIds],
      leaseMs: normalizedLeaseMs,
      nowMs: clock(),
    });
    if (!claim) {
      break;
    }
    claimed += 1;
    seenWorkIds.add(claim.work.workId);

    const outcome = await handleWithHeartbeat({
      claim,
      clock,
      handle,
      heartbeatMs: normalizedHeartbeatMs,
      leaseMs: normalizedLeaseMs,
      queue,
    });
    if (outcome.ok) {
      // Keep ack outside handler error handling. An uncertain ack must surface
      // and remain recoverable by lease expiry, never be converted to a nack.
      await queue.ack(outcome.claim);
      succeeded += 1;
      continue;
    }

    const configuredDelay =
      typeof retryDelayMs === "function"
        ? retryDelayMs(outcome.claim.attempt)
        : retryDelayMs;
    await queue.nack(outcome.claim, {
      retryAtMs: clock() + Math.max(0, Math.floor(configuredDelay)),
    });
    failed += 1;
    await onError?.({
      claim: outcome.claim,
      error: outcome.error,
      work: outcome.claim.work,
    });
  }

  return { claimed, failed, succeeded };
}

interface HeartbeatHandlerOptions {
  readonly claim: SqlQueueClaim;
  readonly clock: () => number;
  readonly handle: (work: SqlQueueWork, claim: SqlQueueClaim) => Promise<void>;
  readonly heartbeatMs: number;
  readonly leaseMs: number;
  readonly queue: SqlQueuePort;
}

async function handleWithHeartbeat({
  claim,
  clock,
  handle,
  heartbeatMs,
  leaseMs,
  queue,
}: HeartbeatHandlerOptions): Promise<HandlerOutcome> {
  let active = true;
  let currentClaim = claim;
  let renewalError: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal = Promise.resolve();

  const scheduleRenewal = (): void => {
    // Anchor cadence to the lease's absolute deadline. A slow renewal response
    // must consume the next delay rather than shift the whole cadence later.
    const remainingMs = currentClaim.leaseUntilMs - clock();
    const delayMs = Math.max(
      0,
      Math.min(heartbeatMs, remainingMs - heartbeatMs)
    );
    timer = setTimeout(() => {
      const nowMs = clock();
      renewal = queue
        .renewLease(currentClaim, {
          leaseUntilMs: nowMs + leaseMs,
          nowMs,
        })
        .then((renewed) => {
          currentClaim = renewed;
          if (active) {
            scheduleRenewal();
          }
        })
        .catch((error: unknown) => {
          renewalError = error;
        });
    }, delayMs);
  };
  scheduleRenewal();

  let handlerError: unknown;
  let handlerFailed = false;
  try {
    await handle(claim.work, claim);
  } catch (error) {
    handlerError = error;
    handlerFailed = true;
  } finally {
    active = false;
    clearTimeout(timer);
    await renewal;
  }

  if (renewalError !== undefined) {
    throw renewalError;
  }
  return handlerFailed
    ? { claim: currentClaim, error: handlerError, ok: false }
    : { claim: currentClaim, ok: true };
}
