import type { ModelMessage } from "ai";
import type {
  AutoCompactionDiagnosticMetadata,
  RuntimeDiagnostic,
} from "../../diagnostics";
import {
  defaultModelPromptMeasurementProfile,
  estimateModelMessagesTokens,
} from "../../llm/context-gate";
import type { ContextTokenView } from "../../llm/context-tokens";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import { hydrateRuntimeAttachments } from "../input/attachments";
import { compactionContextForModel } from "../state/context";
import type { ThreadCompactionInput, ThreadState } from "../state/thread-state";
import {
  buildCompactionSummaryInstructions,
  summarizeCompactionRange,
  summaryHistoryForRange,
} from "./auto-compaction-summary";
import {
  type AgentCompaction,
  type AgentCompactionReason,
  type AutoCompactionRange,
  type CompactionSummaryOptions,
  DEFAULT_COMPACTION_DEADLINE_MS,
  type ThreadCompactionHandler,
  type ThreadContextTransformObserver,
  type ThreadModelContextTransform,
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
  Omit<
    RunOptions,
    "compactionId" | "deadlineAt" | "deadlineMs" | "reason" | "runnerAttempt"
  >
>();
const blockingCompactions = new WeakSet<ThreadState>();

interface RunOptions {
  readonly compact?: ThreadCompactionHandler;
  readonly compaction?: AgentCompaction;
  readonly compactionId?: string;
  readonly deadlineAt?: number;
  readonly deadlineMs?: number;
  readonly latestContextTransform?: ThreadContextTransformObserver;
  readonly model: ModelGenerationOptions;
  readonly reason: AgentCompactionReason;
  readonly runnerAttempt?: number;
  readonly signal?: AbortSignal;
  readonly state: ThreadState;
  readonly threadKey: string;
  readonly transformModelContext?: ThreadModelContextTransform;
}

export class CompactionDeadlineExceededError extends Error {
  readonly deadlineAt: number;
  readonly deadlineMs: number;
  readonly name = "CompactionDeadlineExceededError";
  readonly reason: AgentCompactionReason;
  readonly threadKey: string;

  constructor({
    cause,
    deadlineAt,
    deadlineMs,
    reason,
    threadKey,
  }: {
    readonly cause?: unknown;
    readonly deadlineAt: number;
    readonly deadlineMs: number;
    readonly reason: AgentCompactionReason;
    readonly threadKey: string;
  }) {
    super(`Compaction exceeded its ${deadlineMs}ms deadline.`, { cause });
    this.deadlineAt = deadlineAt;
    this.deadlineMs = deadlineMs;
    this.reason = reason;
    this.threadKey = threadKey;
  }
}

export function scheduleThreadCompaction(
  options: Omit<
    RunOptions,
    "compactionId" | "deadlineAt" | "deadlineMs" | "reason" | "runnerAttempt"
  >
): Promise<void> {
  if (!options.compaction) {
    return Promise.resolve();
  }
  if (activeCompactions.has(options.state)) {
    pendingCompactions.set(options.state, options);
    return Promise.resolve();
  }
  let deadline: ReturnType<typeof compactionDeadline>;
  try {
    deadline = compactionDeadline(options.compaction);
  } catch {
    return Promise.resolve();
  }
  const runOptions = {
    ...options,
    ...deadline,
    compactionId: crypto.randomUUID(),
    reason: "completed-turn" as const,
    runnerAttempt: 1,
  };
  return runSingleFlight(runOptions)
    .catch(async (error: unknown) => {
      if (error instanceof CompactionDeadlineExceededError) {
        return;
      }
      if (blockingCompactions.has(options.state)) {
        return;
      }
      await runSingleFlight({ ...runOptions, runnerAttempt: 2 }).catch(
        () => false
      );
    })
    .then(() => undefined);
}

export async function compactThreadBlocking(
  options: Omit<
    RunOptions,
    "compactionId" | "deadlineAt" | "deadlineMs" | "reason" | "runnerAttempt"
  >
): Promise<boolean> {
  if (!options.compaction) {
    return false;
  }
  blockingCompactions.add(options.state);
  try {
    return await runSingleFlight({
      ...options,
      ...compactionDeadline(options.compaction),
      compactionId: crypto.randomUUID(),
      reason: "overflow",
      runnerAttempt: 1,
    });
  } finally {
    blockingCompactions.delete(options.state);
  }
}

/** Force a compaction through the same snapshot, transform, and freshness
 * pipeline used by automatic compaction. */
export async function compactThreadManually(
  options: Omit<
    RunOptions,
    "compaction" | "deadlineAt" | "deadlineMs" | "reason"
  > & {
    readonly summaryOptions?: CompactionSummaryOptions;
  }
): Promise<boolean> {
  const compaction: AgentCompaction = async (
    context
  ): Promise<ThreadCompactionInput | undefined> => {
    if (context.history.length === 0) {
      return;
    }
    const range = { endSeqExclusive: context.history.length, startSeq: 0 };
    return {
      ...range,
      summary: await context.summarize(range, options.summaryOptions),
    };
  };
  return await runSingleFlight({
    ...options,
    ...compactionDeadline(compaction),
    compaction,
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
    .then(() => compactThreadWithinDeadline(options))
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

async function compactThreadWithinDeadline(
  options: RunOptions
): Promise<boolean> {
  const counters: CompactionCounters = {
    commitStarted: false,
    summaryCalls: 0,
  };
  const startedAt = performance.now();
  const deadlineAt = options.deadlineAt;
  try {
    const committed =
      deadlineAt === undefined
        ? await compactThreadOnce(options, counters)
        : await compactThreadBeforeDeadline(options, counters);
    reportCompaction(options, counters, startedAt, {
      outcome: committed ? "committed" : "skipped",
    });
    return committed;
  } catch (error) {
    reportCompaction(options, counters, startedAt, {
      outcome:
        error instanceof CompactionDeadlineExceededError
          ? "timed-out"
          : "failed",
    });
    throw error;
  }
}

interface CompactionCounters {
  commitStarted: boolean;
  summaryCalls: number;
}

async function compactThreadBeforeDeadline(
  options: RunOptions,
  counters: CompactionCounters
): Promise<boolean> {
  const deadlineAt = options.deadlineAt;
  if (deadlineAt === undefined) {
    return await compactThreadOnce(options, counters);
  }
  const remainingMs = deadlineAt - Date.now();
  const timeoutError = new CompactionDeadlineExceededError({
    deadlineAt,
    deadlineMs: options.deadlineMs ?? Math.max(0, remainingMs),
    reason: options.reason,
    threadKey: options.threadKey,
  });
  if (remainingMs <= 0) {
    throw timeoutError;
  }
  const controller = new AbortController();
  const abortFromCaller = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(timeoutError),
    Math.max(0, remainingMs)
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!counters.commitStarted) {
          reject(controller.signal.reason);
        }
      },
      { once: true }
    );
  });
  try {
    return await Promise.race([
      compactThreadOnce({ ...options, signal: controller.signal }, counters),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function compactThreadOnce(
  options: RunOptions,
  counters: CompactionCounters
): Promise<boolean> {
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
  signalForOptions(options).throwIfAborted();
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
  const signal = signalForOptions(options);
  const summarize = async (
    range: AutoCompactionRange,
    summaryOptions: CompactionSummaryOptions = {}
  ): Promise<string> => {
    counters.summaryCalls += 1;
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
  const input = await options.compaction?.(
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
      ...(options.deadlineAt === undefined
        ? {}
        : { deadlineAt: options.deadlineAt }),
      threadIdentity: state.compactionIdentity,
      threadKey: options.threadKey,
    })
  );
  signal.throwIfAborted();
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
    signal.throwIfAborted();
    counters.commitStarted = true;
    return await options.compact(input, fresh);
  }
  if (!fresh(input)) {
    return false;
  }
  signal.throwIfAborted();
  counters.commitStarted = true;
  await state.compact(input);
  return true;
}

function reportCompaction(
  options: RunOptions,
  counters: CompactionCounters,
  startedAt: number,
  result: {
    readonly outcome: AutoCompactionDiagnosticMetadata["outcome"];
  }
): void {
  const diagnostics = options.model.diagnostics;
  if (!diagnostics) {
    return;
  }
  const compaction: AutoCompactionDiagnosticMetadata = {
    compactionId: options.compactionId ?? crypto.randomUUID(),
    ...(options.deadlineAt === undefined
      ? {}
      : { deadlineAt: options.deadlineAt }),
    durationMs: performance.now() - startedAt,
    outcome: result.outcome,
    reason: options.reason,
    runnerAttempt: options.runnerAttempt ?? 1,
    summaryCalls: counters.summaryCalls,
  };
  const diagnostic: RuntimeDiagnostic = {
    code:
      result.outcome === "committed"
        ? "compaction.completed"
        : `compaction.${result.outcome}`,
    compaction,
    level:
      result.outcome === "failed" || result.outcome === "timed-out"
        ? "error"
        : "info",
    phase: "auto-compaction",
  };
  Promise.resolve()
    .then(() => diagnostics.report(diagnostic))
    .catch(() => undefined);
}

function compactionDeadline(compaction: AgentCompaction): {
  readonly deadlineAt: number;
  readonly deadlineMs: number;
} {
  const deadlineMs =
    compaction.deadlineMs?.() ?? DEFAULT_COMPACTION_DEADLINE_MS;
  if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    throw new TypeError(
      "Agent compaction deadlineMs() must return a positive finite number."
    );
  }
  return { deadlineAt: Date.now() + deadlineMs, deadlineMs };
}

function signalForOptions(options: RunOptions): AbortSignal {
  return options.signal ?? new AbortController().signal;
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
