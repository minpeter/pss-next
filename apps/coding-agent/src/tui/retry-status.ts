/**
 * Live countdown state for a runtime `model-retry` wait.
 *
 * The runtime owns the retry decision; this module only turns a scheduled
 * wait into the one-row foreground status the footer already renders. It is
 * deliberately clock-injected so tests drive the countdown with fake timers
 * instead of sleeping.
 */

const RETRY_TICK_INTERVAL_MS = 1000;
const MILLISECONDS_PER_SECOND = 1000;

export interface RetryWaitSchedule {
  /** Last physical call number; 0 when nothing was called yet. */
  readonly attempt: number;
  readonly delayMs: number;
  /** Unspent retry budget INCLUDING the scheduled retry. */
  readonly remainingRetries: number;
  /** Unix epoch milliseconds the next attempt is due at. */
  readonly retryAt: number;
}

/**
 * Formats the footer label. The attempt shown is the call the wait leads to,
 * so it is one past the last physical call the runtime reported.
 */
export const retryWaitMessage = ({
  attempt,
  remainingMs,
  remainingRetries,
}: {
  attempt: number;
  remainingMs: number;
  remainingRetries: number;
}): string => {
  const countdown =
    remainingMs > 0
      ? `Retrying in ${Math.ceil(remainingMs / MILLISECONDS_PER_SECOND)}s`
      : "Retrying now";
  const budget = `${remainingRetries} ${
    remainingRetries === 1 ? "retry" : "retries"
  } left`;
  return `${countdown} · attempt ${attempt + 1} · ${budget}`;
};

export interface RetryStatus {
  /** Drops the wait status without emitting a message when nothing waits. */
  clear(): void;
  isWaiting(): boolean;
  scheduled(schedule: RetryWaitSchedule): void;
  /** Tears the timer down for good; never emits. */
  stop(): void;
}

export const createRetryStatus = ({
  now,
  setMessage,
}: {
  now: () => number;
  /** Receives the countdown label, or `null` once the wait is over. */
  setMessage: (message: string | null) => void;
}): RetryStatus => {
  let schedule: RetryWaitSchedule | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const stopTicker = (): void => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const emit = (): void => {
    if (!schedule) {
      return;
    }
    setMessage(
      retryWaitMessage({
        attempt: schedule.attempt,
        remainingMs: Math.max(0, schedule.retryAt - now()),
        remainingRetries: schedule.remainingRetries,
      })
    );
  };

  return {
    clear(): void {
      if (!schedule) {
        return;
      }
      schedule = undefined;
      stopTicker();
      setMessage(null);
    },
    isWaiting: () => schedule !== undefined,
    scheduled(next: RetryWaitSchedule): void {
      schedule = next;
      emit();
      if (ticker === undefined) {
        ticker = setInterval(emit, RETRY_TICK_INTERVAL_MS);
        // A pending countdown must never hold the process open by itself.
        ticker.unref?.();
      }
    },
    stop(): void {
      schedule = undefined;
      stopTicker();
    },
  };
};
