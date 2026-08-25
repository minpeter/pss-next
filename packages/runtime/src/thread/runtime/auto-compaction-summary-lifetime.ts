import {
  type CompactionSummaryOptions,
  DETACHED_SUMMARY_BACKSTOP_MS,
} from "./auto-compaction-types";

export interface SummaryLifetimeSignal {
  readonly release: () => void;
  readonly signal: AbortSignal;
}

/**
 * Resolves the provider-call signal for a summary. Episode-lifetime calls bind
 * the episode (deadline-armed) signal. Detached calls exclude it so the
 * provider work survives the caller's wait bound, and are contained only by an
 * explicit caller signal plus a fixed leak backstop.
 */
export function resolveSummaryLifetimeSignal({
  episodeSignal,
  options,
}: {
  readonly episodeSignal: AbortSignal;
  readonly options: CompactionSummaryOptions;
}): SummaryLifetimeSignal {
  if (options.lifetime !== "detached") {
    return {
      release: () => undefined,
      signal: options.signal
        ? AbortSignal.any([episodeSignal, options.signal])
        : episodeSignal,
    };
  }
  const backstop = new AbortController();
  const timer = setTimeout(() => {
    backstop.abort(
      new Error("Detached compaction summary exceeded the safety backstop.")
    );
  }, DETACHED_SUMMARY_BACKSTOP_MS);
  timer.unref();
  return {
    release: () => clearTimeout(timer),
    signal: options.signal
      ? AbortSignal.any([options.signal, backstop.signal])
      : backstop.signal,
  };
}
