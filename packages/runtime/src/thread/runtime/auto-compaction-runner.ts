import type { ModelMessage } from "ai";
import { estimateModelMessagesTokens } from "../../llm/context-gate";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import { hydrateRuntimeAttachments } from "../input/attachments";
import { compactionContextForModel } from "../state/context";
import type { ThreadState } from "../state/thread-state";
import {
  summarizeCompactionRange,
  summaryHistoryForRange,
} from "./auto-compaction-summary";
import type {
  AgentCompaction,
  AgentCompactionReason,
  AutoCompactionRange,
  ThreadCompactionHandler,
  ThreadContextTransformObserver,
  ThreadModelContextTransform,
} from "./auto-compaction-types";
import { equalSnapshot } from "./snapshot-equal";
import { estimatorForCompaction } from "./speculative-compaction";

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
  readonly compaction?: AgentCompaction;
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

function runSingleFlight(options: RunOptions): Promise<boolean> {
  const existing = activeCompactions.get(options.state);
  if (existing) {
    if (options.reason === "overflow" && existing.reason === "completed-turn") {
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
  const estimate = options.compaction
    ? (estimatorForCompaction(options.compaction) ??
      estimateModelMessagesTokens)
    : estimateModelMessagesTokens;
  const instructionsTokens = options.model.instructions
    ? estimate([{ content: options.model.instructions, role: "system" }])
    : 0;
  const observation = options.latestContextTransform?.();
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
  const transformOverhead = Math.max(
    0,
    estimate(observedOutput) - estimate(observedInput)
  );
  const fixedTokens = instructionsTokens + transformOverhead;
  const signal = options.signal ?? new AbortController().signal;
  const summarize = async (range: AutoCompactionRange): Promise<string> => {
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
      transformModelContext: options.transformModelContext,
    });
  };
  const input = await options.compaction?.(
    Object.freeze({
      compactions,
      estimatedContextTokens: estimate(hydratedModelContext) + fixedTokens,
      estimatedHistory,
      history,
      instructionsTokens: fixedTokens,
      modelContext: hydratedModelContext,
      reason: options.reason,
      signal,
      summarize,
      threadIdentity: state.compactionIdentity,
      threadKey: options.threadKey,
    })
  );
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
