import type { ModelMessage } from "ai";
import {
  defaultModelPromptMeasurementProfile,
  estimateModelMessagesTokens,
} from "../../llm/context-gate";
import type { ContextTokenView } from "../../llm/context-tokens";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import { hydrateRuntimeAttachments } from "../input/attachments";
import { compactionContextForModel } from "../state/context";
import type { ThreadState } from "../state/thread-state";
import {
  buildCompactionSummaryInstructions,
  summarizeCompactionRange,
  summaryHistoryForRange,
} from "./auto-compaction-summary";
import type {
  AgentCompaction,
  AgentCompactionPolicy,
  AgentCompactionReason,
  AutoCompactionRange,
  CompactionSummaryOptions,
  ThreadCompactionHandler,
  ThreadContextTransformObserver,
  ThreadModelContextTransform,
} from "./auto-compaction-types";
import {
  invokeCompaction,
  threadEstimatorForCompaction,
} from "./auto-compaction-types";
import { equalSnapshot } from "./snapshot-equal";

interface ActiveCompaction {
  readonly promise: Promise<boolean>;
  readonly reason: AgentCompactionReason;
}
const activeCompactions = new WeakMap<ThreadState, ActiveCompaction>();
const pendingCompactions = new WeakMap<
  ThreadState,
  Omit<RunOptions, "reason">
>();

interface RunOptions {
  readonly compact?: ThreadCompactionHandler;
  readonly compaction?: AgentCompaction | AgentCompactionPolicy;
  readonly latestContextTransform?: ThreadContextTransformObserver;
  readonly model: ModelGenerationOptions;
  readonly reason: AgentCompactionReason;
  readonly signal?: AbortSignal;
  readonly state: ThreadState;
  readonly threadKey: string;
  readonly transformModelContext?: ThreadModelContextTransform;
}

export function scheduleThreadCompaction(
  options: Omit<RunOptions, "reason">
): void {
  if (!options.compaction) {
    return;
  }
  if (activeCompactions.has(options.state)) {
    pendingCompactions.set(options.state, options);
    return;
  }
  runSingleFlight({ ...options, reason: "completed-turn" }).catch(() => false);
}

export async function compactThreadBlocking(
  options: Omit<RunOptions, "reason">
): Promise<boolean> {
  if (!options.compaction) {
    return false;
  }
  return await runSingleFlight({ ...options, reason: "overflow" });
}

/** Force a compaction through the same snapshot, transform, and freshness
 * pipeline used by automatic compaction. */
export async function compactThreadManually(
  options: Omit<RunOptions, "compaction" | "reason"> & {
    readonly summaryOptions?: CompactionSummaryOptions;
  }
): Promise<boolean> {
  return await runSingleFlight({
    ...options,
    compaction: async (context) => {
      if (context.history.length === 0) {
        return;
      }
      const range = { endSeqExclusive: context.history.length, startSeq: 0 };
      return {
        ...range,
        summary: await context.summarize(range, options.summaryOptions),
      };
    },
    reason: "manual",
  });
}

function runSingleFlight(options: RunOptions): Promise<boolean> {
  const existing = activeCompactions.get(options.state);
  if (existing) {
    if (
      options.reason !== "completed-turn" &&
      existing.reason === "completed-turn"
    ) {
      return existing.promise
        .catch(() => false)
        .then(
          async (compacted) => (await runSingleFlight(options)) || compacted
        );
    }
    return existing.promise;
  }
  // Register the flight now, but defer all snapshot cloning, estimation, and
  // policy work until a promise turn.
  const running = Promise.resolve()
    .then(() => compactThreadOnce(options))
    .finally(() => {
      activeCompactions.delete(options.state);
      const pending = pendingCompactions.get(options.state);
      if (pending) {
        pendingCompactions.delete(options.state);
        scheduleThreadCompaction(pending);
      }
    });
  activeCompactions.set(options.state, {
    promise: running,
    reason: options.reason,
  });
  return running;
}

async function compactThreadOnce(options: RunOptions): Promise<boolean> {
  const { state } = options;
  const legacyEstimate = options.compaction
    ? threadEstimatorForCompaction(options.compaction)
    : undefined;
  const meterView = legacyEstimate
    ? undefined
    : options.model.contextTokenMeter?.view();
  const observationSnapshot = options.latestContextTransform?.();
  const observation = observationSnapshot
    ? deepFreeze(structuredClone(observationSnapshot))
    : undefined;
  const history = deepFreeze(structuredClone(state.modelSnapshot()));
  const compactions = deepFreeze(structuredClone(state.compactionSnapshot()));
  const rawModelContext = state
    .modelContextSnapshot()
    .map((message) =>
      message.role === "compaction"
        ? compactionContextForModel(message)
        : message
    );
  const estimatedHistory = deepFreeze(
    await hydrateRuntimeAttachments(history, options.model.attachmentStore)
  );
  const hydratedModelContext = deepFreeze(
    await hydrateRuntimeAttachments(
      rawModelContext,
      options.model.attachmentStore
    )
  );
  const observedInput = observation
    ? await hydrateRuntimeAttachments(
        modelMessagesForEstimate(observation.input),
        options.model.attachmentStore
      )
    : [];
  const observedOutput = observation
    ? await hydrateRuntimeAttachments(
        modelMessagesForEstimate(observation.output),
        options.model.attachmentStore
      )
    : [];
  const {
    estimate,
    estimatedContextTokens,
    estimatedHistoryMessageTokens,
    fixedTokens,
  } = compactionTokenAccounting({
    estimatedHistory,
    hydratedModelContext,
    legacyEstimate,
    meterView,
    model: options.model,
    observedInput,
    observedOutput,
  });
  const signal = options.signal ?? new AbortController().signal;
  const summarize = async (
    range: AutoCompactionRange,
    summaryOptions: CompactionSummaryOptions = {}
  ): Promise<string> => {
    assertRange(range, history.length);
    const summaryHistory = summaryHistoryForRange({
      compactions,
      history,
      range,
    });
    return await summarizeCompactionRange({
      estimateTokens: estimate,
      history: summaryHistory,
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
  };
  const input = options.compaction
    ? await invokeCompaction(
        options.compaction,
        Object.freeze({
          compactions,
          estimatedContextTokens,
          estimatedHistory,
          ...(estimatedHistoryMessageTokens
            ? { estimatedHistoryMessageTokens }
            : {}),
          estimateTokens: estimate,
          history,
          instructionsTokens: fixedTokens,
          modelContext: hydratedModelContext,
          reason: options.reason,
          signal,
          summarize,
          threadIdentity: state.compactionIdentity,
          threadKey: options.threadKey,
        })
      )
    : undefined;
  if (!input) {
    return false;
  }
  assertRange(input, history.length);
  if (!input.summary.trim()) {
    return false;
  }
  const fresh = (candidate: typeof input): boolean => {
    if (!candidate.summary.trim()) {
      return false;
    }
    try {
      assertRange(candidate, history.length);
    } catch {
      return false;
    }
    return (
      equalSnapshot(compactions, state.compactionSnapshot()) &&
      equalSnapshot(
        history.slice(0, candidate.endSeqExclusive),
        state.modelSnapshot().slice(0, candidate.endSeqExclusive)
      )
    );
  };
  if (!fresh(input)) {
    return false;
  }
  if (options.compact) {
    return await options.compact(input, fresh);
  }
  if (!fresh(input)) {
    return false;
  }
  await state.compact(input);
  return true;
}

function compactionTokenAccounting({
  estimatedHistory,
  hydratedModelContext,
  legacyEstimate,
  meterView,
  model,
  observedInput,
  observedOutput,
}: {
  readonly estimatedHistory: readonly ModelMessage[];
  readonly hydratedModelContext: readonly ModelMessage[];
  readonly legacyEstimate?: (messages: readonly ModelMessage[]) => number;
  readonly meterView?: ContextTokenView;
  readonly model: ModelGenerationOptions;
  readonly observedInput: readonly ModelMessage[];
  readonly observedOutput: readonly ModelMessage[];
}): {
  readonly estimate: (messages: readonly ModelMessage[]) => number;
  readonly estimatedContextTokens: number;
  readonly estimatedHistoryMessageTokens?: readonly number[];
  readonly fixedTokens: number;
} {
  const measurementProfile =
    model.contextTokens?.measurementProfile ??
    defaultModelPromptMeasurementProfile;
  let estimate = legacyEstimate ?? estimateModelMessagesTokens;
  if (meterView) {
    estimate = (messages) =>
      meterView
        .estimateMessageUnits(measurementProfile.measureMessages(messages))
        .reduce((sum, tokens) => sum + tokens, 0);
  }

  const instructionsTokens =
    meterView || !model.instructions
      ? 0
      : estimate([{ content: model.instructions, role: "system" }]);
  const transformOverhead = Math.max(
    0,
    estimate(observedOutput) - estimate(observedInput)
  );
  const legacyFixedTokens = instructionsTokens + transformOverhead;
  const meterProfile = meterView?.profile({
    contextMessageUnits:
      measurementProfile.measureMessages(hydratedModelContext),
    historyMessageUnits: measurementProfile.measureMessages(estimatedHistory),
  });
  let estimatedHistoryMessageTokens: readonly number[] | undefined;
  if (meterProfile) {
    estimatedHistoryMessageTokens = meterProfile.historyMarginal;
  } else if (legacyEstimate) {
    estimatedHistoryMessageTokens = estimatedHistory.map((message) =>
      estimate([message])
    );
  }
  const fixedTokens = meterProfile
    ? meterProfile.fixedPrompt + transformOverhead
    : legacyFixedTokens;
  return {
    estimate,
    estimatedContextTokens: meterProfile
      ? meterProfile.fullInput + transformOverhead
      : estimate(hydratedModelContext) + fixedTokens,
    ...(estimatedHistoryMessageTokens ? { estimatedHistoryMessageTokens } : {}),
    fixedTokens,
  };
}

function assertRange(range: AutoCompactionRange, length: number): void {
  if (
    !(
      Number.isSafeInteger(range.startSeq) &&
      Number.isSafeInteger(range.endSeqExclusive)
    ) ||
    range.startSeq < 0 ||
    range.endSeqExclusive <= range.startSeq ||
    range.endSeqExclusive > length
  ) {
    throw new TypeError(
      "Compaction callback returned an invalid source range."
    );
  }
}

function modelMessagesForEstimate(
  messages: Parameters<NonNullable<ThreadModelContextTransform>>[0]
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

/** Bound summary output using both the retained-context target and source size. */
export function selectSummaryOutputTokenLimit({
  inputTokens,
  retainTokens,
}: {
  readonly inputTokens: number;
  readonly retainTokens: number;
}): number {
  const policyCeiling = Math.min(
    16_384,
    Math.max(512, Math.floor(retainTokens / 2))
  );
  const inputCeiling = Math.max(256, Math.floor(inputTokens / 2));
  return Math.min(policyCeiling, inputCeiling);
}
