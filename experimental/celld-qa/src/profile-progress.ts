import type { MonotonicClock, ProgressSnapshot } from "./profile-types";

export interface ProgressReporter {
  readonly finish: (snapshot: ProgressSnapshot) => void;
  readonly record: (snapshot: ProgressSnapshot) => void;
}

interface ProgressOptions {
  readonly clock: MonotonicClock;
  readonly sink: (jsonLine: string) => void;
}

export function createProgressReporter({
  clock,
  sink,
}: ProgressOptions): ProgressReporter {
  let lastCompleted = 0;
  let lastEmittedAt = clock.now();
  let finished = false;
  const emit = (snapshot: ProgressSnapshot, final: boolean): void => {
    sink(`${JSON.stringify({ ...snapshot, atMs: clock.now(), final })}\n`);
    lastCompleted = snapshot.completed;
    lastEmittedAt = clock.now();
  };
  return {
    finish: (snapshot) => {
      if (!finished) {
        finished = true;
        emit(snapshot, true);
      }
    },
    record: (snapshot) => {
      if (
        !finished &&
        (snapshot.completed - lastCompleted >= 100 ||
          clock.now() - lastEmittedAt >= 10_000)
      ) {
        emit(snapshot, false);
      }
    },
  };
}
