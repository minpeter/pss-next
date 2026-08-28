import type { MonotonicClock, ProgressSnapshot } from "./profile-types";

export interface ProgressReporter {
  readonly finish: (snapshot: ProgressSnapshot) => Promise<void>;
  readonly record: (snapshot: ProgressSnapshot) => Promise<void>;
}

interface ProgressOptions {
  readonly clock: MonotonicClock;
  readonly sink: (jsonLine: string) => Promise<void> | void;
}

export function createProgressReporter({
  clock,
  sink,
}: ProgressOptions): ProgressReporter {
  let lastCompleted = 0;
  let lastEmittedAt = clock.now();
  let finished = false;
  const emit = async (
    snapshot: ProgressSnapshot,
    final: boolean
  ): Promise<void> => {
    await sink(
      `${JSON.stringify({ ...snapshot, atMs: clock.now(), final })}\n`
    );
    lastCompleted = snapshot.completed;
    lastEmittedAt = clock.now();
  };
  return {
    finish: async (snapshot) => {
      if (!finished) {
        finished = true;
        await emit(snapshot, true);
      }
    },
    record: async (snapshot) => {
      if (
        !finished &&
        (snapshot.completed - lastCompleted >= 100 ||
          clock.now() - lastEmittedAt >= 10_000)
      ) {
        await emit(snapshot, false);
      }
    },
  };
}
