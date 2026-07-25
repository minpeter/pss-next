import type { ModelMessage } from "ai";
import { estimateModelMessagesTokens } from "../../llm/context-gate";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import { hydrateRuntimeAttachments } from "../input/attachments";
import {
  compactionContextForModel,
  type ThreadContextMessage,
} from "../state/context";
import type { ThreadState } from "../state/thread-state";
import { selectAutoCompactionRange } from "./auto-compaction-range";
import {
  summarizeCompactionRange,
  summaryHistoryForRange,
} from "./auto-compaction-summary";
import type {
  AutoCompactionRange,
  ThreadAutoCompactionOptions,
  ThreadCompactionHandler,
  ThreadModelContextTransform,
} from "./auto-compaction-types";

const activeCompactions = new WeakSet<ThreadState>();

export function scheduleThreadAutoCompaction({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy?: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): void {
  if (!policy) {
    return;
  }

  if (activeCompactions.has(state)) {
    return;
  }
  activeCompactions.add(state);
  queueMicrotask(() => {
    const backgroundCompaction = compactThreadInBackground({
      compact,
      model,
      policy,
      state,
      transformModelContext,
    }).finally(() => {
      activeCompactions.delete(state);
    });
    backgroundCompaction.catch(() => undefined);
  });
}

async function compactThreadInBackground({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<void> {
  try {
    let compacted = false;
    let recordCount = state.compactionSnapshot().length;
    do {
      compacted = await compactThreadOnce({
        compact,
        model,
        policy,
        state,
        transformModelContext,
      });
      const nextRecordCount = state.compactionSnapshot().length;
      if (compacted && nextRecordCount === recordCount) {
        break;
      }
      recordCount = nextRecordCount;
    } while (compacted);
  } catch {
    return;
  }
}

export async function compactThreadBlocking({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy?: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<boolean> {
  if (!policy) {
    return false;
  }

  return await compactThreadOnce({
    compact,
    model,
    policy,
    state,
    transformModelContext,
  });
}

async function compactThreadOnce({
  compact,
  model,
  policy,
  state,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly state: ThreadState;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<boolean> {
  for (;;) {
    const history = state.modelSnapshot();
    const compactions = state.compactionSnapshot();
    const estimation = await estimationContextForCompaction({
      history,
      model,
      policy,
      transformModelContext,
    });
    const range = selectAutoCompactionRange({
      compactions,
      history: estimation.history,
      instructionsTokens: estimation.instructionsTokens,
      policy,
    });
    if (!range) {
      return false;
    }

    const summaryHistory = summaryHistoryForRange({
      compactions,
      history,
      range,
    });
    const summary = await summarizeCompactionRange({
      estimateTokens: policy.estimateTokens,
      history: summaryHistory,
      model: summaryModelOptions(
        model,
        policy,
        estimateSummaryInputTokens(summaryHistory, policy)
      ),
      transformModelContext,
    });
    if (summary.length === 0) {
      return false;
    }

    const latestHistory = state.modelSnapshot();
    const latestEstimation = await estimationContextForCompaction({
      history: latestHistory,
      model,
      policy,
      transformModelContext,
    });
    const latestRange = selectAutoCompactionRange({
      compactions: state.compactionSnapshot(),
      history: latestEstimation.history,
      instructionsTokens: latestEstimation.instructionsTokens,
      policy,
    });
    if (!sameRange(range, latestRange)) {
      continue;
    }

    const input = { ...range, summary };
    if (compact) {
      return await compact(input);
    }
    await state.compact(input);
    return true;
  }
}

async function estimationContextForCompaction({
  history,
  model,
  policy,
  transformModelContext,
}: {
  readonly history: readonly ModelMessage[];
  readonly model: ModelGenerationOptions;
  readonly policy: ThreadAutoCompactionOptions;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<{
  readonly history: readonly ModelMessage[];
  readonly instructionsTokens: number;
}> {
  const hydrated = await hydrateRuntimeAttachments(
    history,
    model.attachmentStore
  );
  const baseInstructions = instructionTokens(model, policy);
  if (!transformModelContext) {
    return {
      history: hydrated,
      instructionsTokens: baseInstructions,
    };
  }

  const estimate = policy.estimateTokens ?? estimateModelMessagesTokens;
  const transformed = await transformModelContext(
    hydrated as readonly ThreadContextMessage[],
    new AbortController().signal
  );
  const transformOverhead = Math.max(
    0,
    estimate(modelMessagesForEstimate(transformed)) -
      estimate(modelMessagesForEstimate(hydrated))
  );
  return {
    history: hydrated,
    instructionsTokens: baseInstructions + transformOverhead,
  };
}

function modelMessagesForEstimate(
  messages: readonly ThreadContextMessage[] | readonly ModelMessage[]
): ModelMessage[] {
  return messages.map((message) =>
    message.role === "compaction"
      ? compactionContextForModel(message)
      : message
  );
}

function sameRange(
  left: AutoCompactionRange,
  right: AutoCompactionRange | undefined
): boolean {
  return (
    right !== undefined &&
    left.startSeq === right.startSeq &&
    left.endSeqExclusive === right.endSeqExclusive
  );
}

function instructionTokens(
  model: ModelGenerationOptions,
  policy: ThreadAutoCompactionOptions
): number {
  if (!model.instructions) {
    return 0;
  }

  const message: ModelMessage = {
    content: model.instructions,
    role: "system",
  };
  const estimate = policy.estimateTokens ?? estimateModelMessagesTokens;
  return estimate([message]);
}

function summaryModelOptions(
  model: ModelGenerationOptions,
  policy: ThreadAutoCompactionOptions,
  inputTokens: number
): ModelGenerationOptions {
  return {
    ...model,
    maxOutputTokens: selectSummaryOutputTokenLimit({
      inputTokens,
      retainTokens: policy.retainTokens,
    }),
    temperature: 0,
  };
}

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

function estimateSummaryInputTokens(
  history: readonly ThreadContextMessage[],
  policy: ThreadAutoCompactionOptions
): number {
  const modelMessages = history.map((message) =>
    message.role === "compaction" ? compactionContextForModel(message) : message
  );
  const estimate = policy.estimateTokens ?? estimateModelMessagesTokens;
  return estimate(modelMessages);
}
