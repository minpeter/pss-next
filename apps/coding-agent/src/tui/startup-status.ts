import { createSpinnerTicker, stylePendingIndicator } from "./pending-spinner";

export async function withStartupStatus<T>(
  operation: () => Promise<T>
): Promise<T> {
  const stop = showStartupStatus();
  try {
    return await operation();
  } finally {
    stop();
  }
}

/** Minimal pre-mount status; relinquishes the line before pi-tui owns stdout. */
export function showStartupStatus(): () => void {
  if (!process.stdout.isTTY) {
    return () => undefined;
  }
  const ticker = createSpinnerTicker((frame) => {
    const width = Math.max(1, process.stdout.columns ?? 80);
    const label = "Starting...".slice(0, Math.max(0, width - 2));
    process.stdout.write(
      `\r\x1b[2K${label ? stylePendingIndicator(frame, label) : frame}`
    );
  });
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    ticker.stop();
    process.stdout.write("\r\x1b[2K");
  };
}
