import type { ModelMessage } from "ai";
import type { ThreadContextMessage } from "../state/context";
import type { ThreadCompactionRecord } from "../state/snapshot";
import type { ThreadCompactionInput } from "../state/thread-state";

export type ThreadTokenEstimator = (
  messages: readonly ModelMessage[]
) => number;

export type AgentCompactionReason = "completed-turn" | "overflow";

export interface CompactionSummaryOptions {
  /** Replaces the runtime's default continuation-handoff instructions. */
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
