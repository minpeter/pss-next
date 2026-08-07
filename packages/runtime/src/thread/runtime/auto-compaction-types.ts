import type { ModelMessage } from "ai";
import type { ContextBudgetSource } from "../../llm/context-gate";
import type { ThreadContextMessage } from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { ThreadCompactionInput } from "../state/thread-state";

export type ThreadTokenEstimator = (
  messages: readonly ModelMessage[]
) => number;

export type AgentCompactionReason = "completed-turn" | "manual" | "overflow";

export type ManualThreadCompactionResult =
  | { readonly status: "compacted" }
  | { readonly status: "empty" }
  | { readonly status: "skipped" };

export interface CompactionSummaryOptions {
  /** Appends an `Additional focus` section to the default handoff contract. */
  readonly instructions?: string;
  /** Controls whether raw tool-result evidence is appended after model output. */
  readonly toolEvidence?: "deterministic" | "omit";
}

export interface AgentCompactionContext {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly estimatedContextTokens: number;
  readonly estimatedHistory: readonly ModelMessage[];
  /** Marginal costs aligned by index with estimatedHistory. */
  readonly estimatedHistoryMessageTokens?: readonly number[];
  /** Runtime-pinned estimator aligned with estimatedContextTokens. */
  readonly estimateTokens?: ThreadTokenEstimator;
  readonly history: readonly ModelMessage[];
  readonly instructionsTokens: number;
  readonly modelContext: readonly ModelMessage[];
  readonly reason: AgentCompactionReason;
  readonly signal: AbortSignal;
  readonly summarize: (
    range: AutoCompactionRange,
    options?: CompactionSummaryOptions
  ) => Promise<string>;
  /** Opaque, stable identity owned by the runtime for this ThreadState. */
  readonly threadIdentity: Readonly<object>;
  readonly threadKey: string;
}

/** A per-thread compaction policy. The runtime owns all state and commits. */
export type AgentCompaction = (
  context: Readonly<AgentCompactionContext>
) =>
  | ThreadCompactionInput
  | undefined
  | Promise<ThreadCompactionInput | undefined>;

/**
 * A compaction strategy that owns the context budget it compacts toward. The
 * runtime passes the policy straight to the model-step context gate, which
 * calls `maxInputTokens()` (and `estimateTokens`, when provided) before every
 * model request. A policy without `compact` is a budget-only source: pair it
 * with `onOverflow: "error"` to fail over-budget turns without rewriting
 * history.
 */
export interface AgentCompactionPolicy extends ContextBudgetSource {
  readonly compact?: (
    context: Readonly<AgentCompactionContext>
  ) =>
    | ThreadCompactionInput
    | undefined
    | Promise<ThreadCompactionInput | undefined>;
}

export function invokeCompaction(
  compaction: AgentCompaction | AgentCompactionPolicy,
  context: Readonly<AgentCompactionContext>
):
  | ThreadCompactionInput
  | undefined
  | Promise<ThreadCompactionInput | undefined> {
  return typeof compaction === "function"
    ? compaction(context)
    : compaction.compact?.(context);
}

/** The thread-history estimator pinned by a policy, when it provides one. */
export function threadEstimatorForCompaction(
  compaction: AgentCompaction | AgentCompactionPolicy
): ThreadTokenEstimator | undefined {
  if (typeof compaction === "function" || !compaction.estimateTokens) {
    return;
  }
  const estimateTokens = compaction.estimateTokens;
  return (messages) => estimateTokens({ messages });
}

export type ThreadModelContextTransform = (
  messages: readonly ThreadContextMessage[],
  signal: AbortSignal
) => Promise<readonly ThreadContextMessage[]>;

export interface ThreadContextTransformObservation {
  readonly input: readonly ThreadContextMessage[];
  readonly output: readonly ThreadContextMessage[];
}

export type ThreadContextTransformObserver = () =>
  | ThreadContextTransformObservation
  | undefined;

export interface AutoCompactionRange {
  readonly endSeqExclusive: number;
  readonly startSeq: number;
}

export type ThreadCompactionFreshnessGuard = (
  input: ThreadCompactionInput
) => boolean;

export type ThreadCompactionHandler = (
  input: ThreadCompactionInput,
  freshnessGuard?: ThreadCompactionFreshnessGuard
) => Promise<boolean>;
