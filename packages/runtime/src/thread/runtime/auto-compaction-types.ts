import type { ModelMessage } from "ai";
import type { ModelContextGateOptions } from "../../llm/context-gate";
import type { ThreadContextMessage } from "../state/context";
import type { ThreadCompactionInput } from "../state/thread-state";

export type ThreadTokenEstimator = (
  messages: readonly ModelMessage[]
) => number;

export interface ThreadAutoCompactionOptions {
  readonly contextGate?: false | ModelContextGateOptions;
  readonly estimateTokens?: ThreadTokenEstimator;
  readonly maxInputTokens: number;
  readonly retainTokens: number;
  readonly triggerTokens: number;
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

export type ThreadCompactionHandler = (
  input: ThreadCompactionInput
) => Promise<boolean>;
