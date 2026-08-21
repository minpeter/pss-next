import type { ModelMessage } from "ai";
import type { ModelContextTokenEstimateInput } from "../../llm/context-gate";
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
  /** Cancels manual compaction and its active provider request. */
  readonly signal?: AbortSignal;
  /** Controls whether raw tool-result evidence is appended after model output. */
  readonly toolEvidence?: "deterministic" | "omit";
}

export interface AgentCompactionContext {
  readonly compactions: readonly ThreadCompactionRecord[];
  readonly deadlineAt?: number;
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

/**
 * A per-thread compaction policy. The runtime owns all state and commits.
 *
 * The function may advertise the context budget it compacts toward by
 * carrying the optional budget properties below. When `maxInputTokens` is
 * present, the runtime passes the function itself to the model-step context
 * gate, which calls it before every model request — budget and compaction
 * thresholds share one source of truth. A bare function without budget
 * properties runs with the local gate off and reacts to provider-thrown
 * context-window errors only. For budget enforcement without history
 * rewriting, attach `maxInputTokens` plus `onOverflow: "error"` to a no-op
 * function.
 */
export interface AgentCompaction {
  readonly bufferTokens?: number;
  readonly deadlineMs?: () => number;
  readonly estimateTokens?: (input: ModelContextTokenEstimateInput) => number;
  readonly maxInputTokens?: () => number;
  readonly onOverflow?: "compact" | "error";
  (
    context: Readonly<AgentCompactionContext>
  ):
    | ThreadCompactionInput
    | undefined
    | Promise<ThreadCompactionInput | undefined>;
}

/** Episode bound used when a policy omits `deadlineMs`. Live `gpt-5.6-luna`
 * summaries complete in about 8-18s; 5s timed out prepared, late, retry, and
 * overflow-recovery paths, while 15s kept those paths at 100% provider start. */
export const DEFAULT_COMPACTION_DEADLINE_MS = 15_000;

/** The thread-history estimator pinned by a compaction, when it provides one. */
export function threadEstimatorForCompaction(
  compaction: AgentCompaction
): ThreadTokenEstimator | undefined {
  const estimateTokens = compaction.estimateTokens;
  if (estimateTokens === undefined) {
    return;
  }
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
