import type { ModelUsage } from "@minpeter/pss-runtime";

/**
 * Rough chars-per-token divisor for the live estimate shown while a step is
 * still streaming (before the authoritative `model-usage` event arrives).
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

export const formatTokens = (n: number): string => {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
};

/**
 * Tracks session token usage for the TUI footer.
 *
 * Authoritative numbers come from `model-usage` events at each step end.
 * Between those, streamed output fragments feed a live estimate (prefixed
 * with `≈`) so the counter moves while the model is generating. When no
 * usage was ever reported and nothing is streaming, the footer is hidden
 * instead of claiming a false "0 tokens".
 */
export class TokenUsageTracker {
  #estimatedChars = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #totalTokens = 0;

  /** Fold an authoritative per-step usage event into the session totals. */
  addUsage(usage: ModelUsage): void {
    // The finished step's live estimate is superseded by the real numbers.
    this.#estimatedChars = 0;
    this.#inputTokens += usage.inputTokens ?? 0;
    this.#outputTokens += usage.outputTokens ?? 0;
    this.#totalTokens +=
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }

  /** Accumulate streamed output text for the live estimate. */
  addOutputDelta(text: string): void {
    this.#estimatedChars += text.length;
  }

  /** Drop a stale estimate left by an aborted or errored step. */
  beginTurn(): void {
    this.#estimatedChars = 0;
  }

  /** Clear everything (e.g. when a new session starts). */
  reset(): void {
    this.#estimatedChars = 0;
    this.#inputTokens = 0;
    this.#outputTokens = 0;
    this.#totalTokens = 0;
  }

  /**
   * Footer text for the current state, or `undefined` when there is nothing
   * truthful to show yet.
   */
  footerText(): string | undefined {
    const estimated = Math.round(
      this.#estimatedChars / ESTIMATED_CHARS_PER_TOKEN
    );
    const hasReportedUsage =
      this.#totalTokens > 0 || this.#inputTokens > 0 || this.#outputTokens > 0;

    if (!hasReportedUsage) {
      // Never claim "0 tokens (0 in / 0 out)" — either show the live
      // estimate or nothing.
      return estimated > 0 ? `≈${formatTokens(estimated)} tokens` : undefined;
    }

    const approx = estimated > 0 ? "≈" : "";
    const total = this.#totalTokens + estimated;
    const output = this.#outputTokens + estimated;
    return `${approx}${formatTokens(total)} tokens (${formatTokens(this.#inputTokens)} in / ${formatTokens(output)} out)`;
  }
}
