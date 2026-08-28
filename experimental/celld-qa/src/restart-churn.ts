export interface ChurnBatchResult {
  readonly cleanup: {
    readonly drained: boolean;
    readonly inFlight: number;
  };
  readonly completed: number;
  readonly correct: number;
}

export interface RestartChurnOptions {
  readonly restart: (completed: number) => Promise<void>;
  readonly restartEvery: number;
  readonly runBatch: (
    requestCount: number,
    offset: number
  ) => Promise<ChurnBatchResult>;
  readonly totalRequests: number;
}

export interface RestartChurnResult extends ChurnBatchResult {
  readonly restarts: number;
}

export class ChurnCleanupError extends Error {
  readonly inFlight: number;
  readonly name = "ChurnCleanupError";

  constructor(inFlight: number) {
    super(`Restart churn batch did not drain ${inFlight} in-flight requests`);
    this.inFlight = inFlight;
  }
}

export class IncompleteChurnBatchError extends Error {
  readonly completed: number;
  readonly expected: number;
  readonly name = "IncompleteChurnBatchError";

  constructor(completed: number, expected: number) {
    super(`Restart churn batch completed ${completed} of ${expected}`);
    this.completed = completed;
    this.expected = expected;
  }
}

export class IncorrectChurnBatchError extends Error {
  readonly completed: number;
  readonly correct: number;
  readonly name = "IncorrectChurnBatchError";

  constructor(correct: number, completed: number) {
    super(`${correct} of ${completed} requests were correct`);
    this.completed = completed;
    this.correct = correct;
  }
}

export async function runRestartChurn({
  restart,
  restartEvery,
  runBatch,
  totalRequests,
}: RestartChurnOptions): Promise<RestartChurnResult> {
  let completed = 0;
  let correct = 0;
  let restarts = 0;
  while (completed < totalRequests) {
    const batchSize = Math.min(restartEvery, totalRequests - completed);
    const batch = await runBatch(batchSize, completed);
    if (batch.completed !== batchSize) {
      throw new IncompleteChurnBatchError(batch.completed, batchSize);
    }
    if (!batch.cleanup.drained || batch.cleanup.inFlight !== 0) {
      throw new ChurnCleanupError(batch.cleanup.inFlight);
    }
    if (batch.correct !== batch.completed) {
      throw new IncorrectChurnBatchError(batch.correct, batch.completed);
    }
    completed += batch.completed;
    correct += batch.correct;
    if (completed < totalRequests) {
      await restart(completed);
      restarts += 1;
    }
  }
  return {
    cleanup: { drained: true, inFlight: 0 },
    completed,
    correct,
    restarts,
  };
}
