import type { ResumeThreadOptions } from "../../execution/host/scheduler-options";
import type { HostScheduler } from "../../execution/host/types";
import {
  type ScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../execution/scheduled-work";

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

/**
 * Durable queue boundary. `enqueue` must be idempotent by `work.workId`.
 * A PostgreSQL implementation can use `INSERT ... ON CONFLICT DO NOTHING`.
 */
export interface SqlQueuePort {
  enqueue(work: SqlQueueWork): Promise<void>;
}

export interface SqlQueueSchedulerOptions {
  readonly clock?: () => number;
  readonly queue: SqlQueuePort;
  /**
   * Signals a worker after durable enqueue. It may publish to a broker,
   * `NOTIFY` PostgreSQL, or update a process timer. The queue remains the
   * source of truth if this callback fails.
   */
  readonly wake?: (dueAtMs: number) => Promise<void> | void;
}

export class SqlQueueScheduler implements HostScheduler {
  readonly #clock: () => number;
  readonly #queue: SqlQueuePort;
  readonly #wake: ((dueAtMs: number) => Promise<void> | void) | undefined;

  constructor({ clock = Date.now, queue, wake }: SqlQueueSchedulerOptions) {
    this.#clock = clock;
    this.#queue = queue;
    this.#wake = wake;
  }

  async enqueueRun(
    runId: string,
    options: { readonly runAfterMs?: number } = {}
  ): Promise<void> {
    const dueAtMs =
      this.#clock() + Math.max(0, Math.floor(options.runAfterMs ?? 0));
    await this.#persistAndWake({
      dueAtMs,
      kind: "run",
      runId,
      workId: `run:${runId}`,
    });
  }

  async resumeThread(
    threadKey: string,
    options: ResumeThreadOptions
  ): Promise<void> {
    const prompt: ScheduledThreadPrompt = {
      idempotencyKey: options.idempotencyKey,
      notificationId: options.notificationId,
      runId: options.runId,
      threadKey,
    };
    await this.#persistAndWake({
      dueAtMs: this.#clock(),
      kind: "thread-prompt",
      prompt,
      workId: `thread-prompt:${threadPromptScheduledWorkId(prompt)}`,
    });
  }

  async #persistAndWake(work: SqlQueueWork): Promise<void> {
    await this.#queue.enqueue(work);
    await this.#wake?.(work.dueAtMs);
  }
}
