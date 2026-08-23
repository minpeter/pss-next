import type { ModelMessage } from "ai";
import { hydrateRuntimeAttachments } from "../input/attachments";
import {
  compactionContextForModel,
  type ThreadContextMessage,
} from "../state/context";
import { equalSnapshot } from "../state/snapshot-equal";
import type { ThreadCompactionInput } from "../state/thread-state";
import type { AutoCompactionEpisodeOptions } from "./auto-compaction-episode";
import {
  buildCompactionSummaryInstructions,
  summarizeCompactionRange,
  summaryHistoryForRange,
} from "./auto-compaction-summary";
import { compactionTokenAccounting } from "./auto-compaction-token-accounting";
import type {
  AgentCompactionModelContextProvenance,
  AutoCompactionRange,
  CompactionSummaryOptions,
  ThreadCompactionFreshnessGuard,
} from "./auto-compaction-types";
import { threadEstimatorForCompaction } from "./auto-compaction-types";

interface PreparedAutoCompaction {
  readonly freshnessGuard: ThreadCompactionFreshnessGuard;
  readonly input: ThreadCompactionInput;
}

interface ModelContextProjection {
  readonly modelContext: readonly ThreadContextMessage[];
  readonly observedInput: readonly ThreadContextMessage[];
  readonly observedOutput: readonly ThreadContextMessage[];
  readonly provenance: AgentCompactionModelContextProvenance;
}

export async function prepareAutoCompaction(
  options: AutoCompactionEpisodeOptions & { readonly signal: AbortSignal },
  recordSummaryCall: () => void
): Promise<PreparedAutoCompaction | undefined> {
  const { state } = options;
  const history = deepFreeze(structuredClone(state.modelSnapshot()));
  const compactions = deepFreeze(structuredClone(state.compactionSnapshot()));
  const standardContext = deepFreeze(
    structuredClone(state.modelContextSnapshot())
  );
  const observationSnapshot = options.latestContextTransform?.();
  const observation = observationSnapshot
    ? deepFreeze(structuredClone(observationSnapshot))
    : undefined;
  const projection = selectModelContextProjection({
    observation,
    observerConfigured: options.latestContextTransform !== undefined,
    standardContext,
  });
  const legacyEstimate = threadEstimatorForCompaction(options.compaction);
  const meterView = legacyEstimate
    ? undefined
    : options.model.contextTokenMeter?.view();
  const standardContextHydration = hydrateRuntimeAttachments(
    modelMessages(standardContext),
    options.model.attachmentStore
  );
  const projectedContextHydration =
    projection.provenance === "transformed"
      ? hydrateRuntimeAttachments(
          modelMessages(projection.modelContext),
          options.model.attachmentStore
        )
      : standardContextHydration;
  const [
    estimatedHistory,
    accountingModelContext,
    hydratedModelContext,
    observedInput,
    observedOutput,
  ] = await Promise.all([
    hydrateRuntimeAttachments(history, options.model.attachmentStore),
    standardContextHydration,
    projectedContextHydration,
    hydrateRuntimeAttachments(
      modelMessages(projection.observedInput),
      options.model.attachmentStore
    ),
    hydrateRuntimeAttachments(
      modelMessages(projection.observedOutput),
      options.model.attachmentStore
    ),
  ]);
  options.signal.throwIfAborted();
  const accounting = compactionTokenAccounting({
    estimatedHistory: deepFreeze(estimatedHistory),
    hydratedModelContext: deepFreeze(accountingModelContext),
    legacyEstimate,
    meterView,
    model: options.model,
    observedInput,
    observedOutput,
  });
  const summarize = (
    range: AutoCompactionRange,
    summaryOptions: CompactionSummaryOptions = {}
  ): Promise<string> => {
    const signal = summaryOptions.signal
      ? AbortSignal.any([options.signal, summaryOptions.signal])
      : options.signal;
    if (signal.aborted) {
      const rejected = Promise.reject<string>(signal.reason);
      rejected.catch(() => undefined);
      return rejected;
    }
    recordSummaryCall();
    assertRange(range, history.length);
    const running = summarizeCompactionRange({
      estimateTokens: accounting.estimate,
      history: summaryHistoryForRange({ compactions, history, range }),
      model: { ...options.model, temperature: 0 },
      signal,
      summaryInstructions:
        summaryOptions.instructions === undefined
          ? undefined
          : `${buildCompactionSummaryInstructions()}

## Additional focus
${summaryOptions.instructions}`,
      toolEvidence: summaryOptions.toolEvidence,
      transformModelContext: options.transformModelContext,
    });
    running.catch(() => undefined);
    return running;
  };
  const input = await options.compaction(
    Object.freeze({
      compactions,
      deadlineAt: options.deadlineAt,
      estimatedContextTokens: accounting.estimatedContextTokens,
      estimatedHistory: deepFreeze(estimatedHistory),
      ...(accounting.estimatedHistoryMessageTokens
        ? {
            estimatedHistoryMessageTokens:
              accounting.estimatedHistoryMessageTokens,
          }
        : {}),
      estimateTokens: accounting.estimate,
      history,
      instructionsTokens: accounting.fixedTokens,
      modelContext: deepFreeze(hydratedModelContext),
      modelContextProvenance: projection.provenance,
      reason: options.reason,
      signal: options.signal,
      summarize,
      threadIdentity: state.compactionIdentity,
      threadKey: options.threadKey,
    })
  );
  options.signal.throwIfAborted();
  if (!input) {
    return;
  }
  assertRange(input, history.length);
  if (!input.summary.trim()) {
    return;
  }
  const freshnessGuard: ThreadCompactionFreshnessGuard = (candidate) =>
    isValidRange(candidate, history.length) &&
    Boolean(candidate.summary.trim()) &&
    equalSnapshot(compactions, state.compactionSnapshot()) &&
    equalSnapshot(
      history.slice(0, candidate.endSeqExclusive),
      state.modelSnapshot().slice(0, candidate.endSeqExclusive)
    );
  return freshnessGuard(input) ? { freshnessGuard, input } : undefined;
}

function selectModelContextProjection({
  observation,
  observerConfigured,
  standardContext,
}: {
  readonly observation:
    | {
        readonly input: readonly ThreadContextMessage[];
        readonly output: readonly ThreadContextMessage[];
      }
    | undefined;
  readonly observerConfigured: boolean;
  readonly standardContext: readonly ThreadContextMessage[];
}): ModelContextProjection {
  if (!(observerConfigured && observation)) {
    return {
      modelContext: standardContext,
      observedInput: [],
      observedOutput: [],
      provenance: observerConfigured ? "unknown" : "standard",
    };
  }
  if (!equalSnapshot(observation.input, standardContext)) {
    return {
      modelContext: standardContext,
      observedInput: [],
      observedOutput: [],
      provenance: "unknown",
    };
  }
  if (equalSnapshot(observation.input, observation.output)) {
    return {
      modelContext: standardContext,
      observedInput: observation.input,
      observedOutput: observation.output,
      provenance: "standard",
    };
  }
  return {
    modelContext: observation.output,
    observedInput: observation.input,
    observedOutput: observation.output,
    provenance: "transformed",
  };
}

function assertRange(range: AutoCompactionRange, length: number): void {
  if (!isValidRange(range, length)) {
    throw new TypeError(
      "Compaction callback returned an invalid source range."
    );
  }
}

function isValidRange(range: AutoCompactionRange, length: number): boolean {
  return (
    Number.isSafeInteger(range.startSeq) &&
    Number.isSafeInteger(range.endSeqExclusive) &&
    range.startSeq >= 0 &&
    range.endSeqExclusive > range.startSeq &&
    range.endSeqExclusive <= length
  );
}

function modelMessages(
  messages: readonly ThreadContextMessage[]
): ModelMessage[] {
  return messages.map((message) =>
    message.role === "compaction" ? compactionContextForModel(message) : message
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) {
      return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
