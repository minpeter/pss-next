import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";

export interface SqlQueueRunWork {
  readonly dueAtMs: number;
  readonly kind: "run";
  readonly runId: string;
  readonly workId: string;
}

export interface SqlQueueThreadPromptWork {
  readonly dueAtMs: number;
  readonly kind: "thread-prompt";
  readonly prompt: ScheduledThreadPrompt;
  readonly workId: string;
}

export type SqlQueueWork = SqlQueueRunWork | SqlQueueThreadPromptWork;

export interface SqlQueueClaim {
  readonly attempt: number;
  readonly claimId: string;
  readonly leaseUntilMs: number;
  readonly work: SqlQueueWork;
}

export interface SqlQueueClaimOptions {
  readonly leaseMs: number;
  readonly nowMs: number;
}

export interface SqlQueueListOptions {
  readonly limit?: number;
  readonly nowMs: number;
}

export interface SqlQueueNackOptions {
  readonly retryAtMs: number;
}

/** Producer-only subset useful to reconciliation and scheduling helpers. */
export interface SqlQueueProducerPort {
  /** Must durably insert idempotently by `work.workId`. */
  enqueue(work: SqlQueueWork): Promise<void>;
}

/**
 * Durable queue boundary for producers and workers.
 *
 * `claim` must atomically lease one due, unacked item and fence competing
 * workers with `claimId`. Expired leases become claimable again. `ack` and
 * `nack` must validate that fence; nack retains the item for `retryAtMs`.
 */
export interface SqlQueuePort extends SqlQueueProducerPort {
  ack(claim: SqlQueueClaim): Promise<void>;
  claim(options: SqlQueueClaimOptions): Promise<SqlQueueClaim | null>;
  list(options: SqlQueueListOptions): Promise<readonly SqlQueueWork[]>;
  nack(claim: SqlQueueClaim, options: SqlQueueNackOptions): Promise<void>;
}
