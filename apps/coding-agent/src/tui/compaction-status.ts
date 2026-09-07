import type {
  AgentCompaction,
  AgentCompactionContext,
} from "@minpeter/pss-runtime";

/** Track speculative policy work too: its summary may outlive the sending turn. */
export function withCompactionStatus(
  policy: AgentCompaction | undefined,
  showStatus: () => (() => void) | undefined
): AgentCompaction | undefined {
  if (policy === undefined) {
    return;
  }
  return Object.assign(async (context: Readonly<AgentCompactionContext>) => {
    // The runtime aborts the episode signal on normal settlement as well as
    // cancellation/deadline. It includes persistence after the policy returns.
    const clearEpisode = showStatus();
    if (clearEpisode) {
      if (context.signal.aborted) {
        clearEpisode();
      } else {
        context.signal.addEventListener("abort", clearEpisode, { once: true });
      }
    }
    // A detached policy/summary can outlive that signal. Keep its own lease
    // until its actual promise settles, even after the episode times out.
    const clear = showStatus();
    try {
      return await policy({
        ...context,
        summarize: async (range, options) => {
          const clearSummary = showStatus();
          try {
            return await context.summarize(range, options);
          } finally {
            clearSummary?.();
          }
        },
      });
    } finally {
      clear?.();
    }
  }, policy);
}
