import type {
  ContextUsageSnapshot,
  TokenEstimate,
} from "@minpeter/pss-runtime";

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

const displayed = (estimate: TokenEstimate): string =>
  `${estimate.basis === "reported" ? "" : "≈"}${formatTokens(estimate.tokens)}`;

/** Pure product formatting for the runtime-owned current-request snapshot. */
export function contextUsageFooter(
  snapshot: ContextUsageSnapshot | undefined
): string | undefined {
  if (!snapshot || snapshot.currentRequest.total.tokens === 0) {
    return;
  }
  const { input, output, total } = snapshot.currentRequest;
  return `${displayed(total)} tokens (${displayed(input)} in / ${displayed(output)} out)`;
}
