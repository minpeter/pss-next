import {
  type AgentCompaction,
  type AgentCompactionContext,
  speculativeCompaction,
} from "@minpeter/pss-runtime";
import {
  type LanguageModelMiddleware,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from "ai";
import type {
  ObservedRuntimeCompactionOptions,
  RuntimeBlockLanguageModel,
  RuntimeBlockModelTrace,
  RuntimeBlockProviderCall,
  RuntimeSummaryTraceSpan,
} from "./runtime-block-time-types";

export type {
  ObservedRuntimeCompactionOptions,
  RuntimeBlockLanguageModel,
  RuntimeBlockModelTrace,
  RuntimeSummaryTraceSpan,
} from "./runtime-block-time-types";

const MAX_INPUT_UNITS = 1000;
const UNIT_MARKER =
  /^\[PSS_BLOCK_BENCH_UNITS=(\d+)\]\n(?:context )+Reply exactly DONE\.$/;

export function runtimeBlockInput(units: number): string {
  const contextWords = Math.max(1, units - 20);
  return `[PSS_BLOCK_BENCH_UNITS=${units}]\n${"context ".repeat(
    contextWords
  )}Reply exactly DONE.`;
}

export const runtimeBlockEstimator: NonNullable<
  AgentCompaction["estimateTokens"]
> = ({ messages }) =>
  messages.reduce((total, message) => {
    if (message.role === "assistant") {
      return total + 50;
    }
    if (message.role !== "user") {
      return total;
    }
    const match =
      typeof message.content === "string"
        ? UNIT_MARKER.exec(message.content)
        : null;
    return total + (match ? Number(match[1]) : 0);
  }, 0);

export function isCompactionProviderPrompt(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) {
    return false;
  }
  const firstMessage: unknown = prompt[0];
  return (
    typeof firstMessage === "object" &&
    firstMessage !== null &&
    Reflect.get(firstMessage, "role") === "system"
  );
}

export function wrapRuntimeBlockModel(
  model: RuntimeBlockLanguageModel,
  middleware: LanguageModelMiddleware
): RuntimeBlockLanguageModel {
  return wrapLanguageModel({
    middleware:
      typeof Reflect.get(model, "doStream") === "function"
        ? middleware
        : [middleware, simulateStreamingMiddleware()],
    model,
  });
}

export function createRuntimeBlockModelTrace(
  model: RuntimeBlockLanguageModel,
  now: () => number,
  sequenceSource?: () => number
): RuntimeBlockModelTrace {
  let sequence = 0;
  const nextSequence =
    sequenceSource ??
    (() => {
      sequence += 1;
      return sequence;
    });
  const calls: RuntimeBlockProviderCall[] = [];
  const listeners = new Set<() => void>();
  const record = (prompt: unknown): void => {
    const kind = isCompactionProviderPrompt(prompt) ? "summary" : "foreground";
    calls.push({
      kind,
      prompt,
      startedAtMs: now(),
      startedSequence: nextSequence(),
    });
    for (const listener of listeners) {
      listener();
    }
  };
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      record(params.prompt);
      return await doGenerate();
    },
    wrapStream: async ({ doStream, params }) => {
      record(params.prompt);
      return await doStream();
    },
  };
  return {
    calls,
    model: wrapRuntimeBlockModel(model, middleware),
    waitForCall: async (kind, afterIndex) => {
      const find = () =>
        calls.slice(afterIndex).find((call) => call.kind === kind);
      const existing = find();
      if (existing) {
        return existing;
      }
      return await new Promise<RuntimeBlockProviderCall>((resolve) => {
        const listener = () => {
          const call = find();
          if (call) {
            listeners.delete(listener);
            resolve(call);
          }
        };
        listeners.add(listener);
      });
    },
  };
}

export function createObservedRuntimeCompaction(
  options: ObservedRuntimeCompactionOptions
): AgentCompaction {
  const { active, deadlineMs, nextSequence, now, onSummarySettled, spans } =
    options;
  const base = speculativeCompaction({
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    estimateTokens: (messages) => runtimeBlockEstimator({ messages }),
    maxInputTokens: MAX_INPUT_UNITS,
    prepareRatio: 0.65,
    promoteRatio: 0.8,
    retainRatio: 0.1,
  });
  const observed: AgentCompaction = async (
    context: Readonly<AgentCompactionContext>
  ) =>
    await base({
      ...context,
      summarize: async (...args) => {
        const span: RuntimeSummaryTraceSpan = {
          endedAtMs: 0,
          endedSequence: 0,
          kind: "summary",
          startedAtMs: now(),
          startedSequence: nextSequence(),
          status: "running",
        };
        const completion = context.summarize(...args).then(
          (summary) => {
            span.endedAtMs = now();
            span.endedSequence = nextSequence();
            span.status = "completed";
            onSummarySettled?.(span);
            return summary;
          },
          (error: unknown) => {
            span.endedAtMs = now();
            span.endedSequence = nextSequence();
            span.status = "error";
            onSummarySettled?.(span);
            throw error;
          }
        );
        const settled = completion.then(
          () => undefined,
          () => undefined
        );
        spans.push(span);
        active.add(settled);
        settled.finally(() => active.delete(settled));
        return await completion;
      },
    });
  return Object.assign(observed, {
    deadlineMs: base.deadlineMs,
    estimateTokens: base.estimateTokens,
    maxInputTokens: base.maxInputTokens,
    onOverflow: base.onOverflow,
  });
}

export async function awaitRuntimeBlockSummaries(
  active: ReadonlySet<Promise<void>>
): Promise<void> {
  while (active.size > 0) {
    await Promise.all([...active]);
  }
}
