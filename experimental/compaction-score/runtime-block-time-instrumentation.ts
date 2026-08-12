import {
  type AgentCompaction,
  type AgentCompactionContext,
  speculativeCompaction,
} from "@minpeter/pss-runtime";
import {
  type LanguageModel,
  type LanguageModelMiddleware,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from "ai";

export type RuntimeBlockLanguageModel = Exclude<LanguageModel, string>;

interface ProviderCall {
  readonly kind: "foreground" | "summary";
  readonly prompt: unknown;
  readonly startedAtMs: number;
}

export interface RuntimeBlockModelTrace {
  readonly calls: readonly ProviderCall[];
  readonly model: RuntimeBlockLanguageModel;
  waitForCall(
    kind: ProviderCall["kind"],
    afterIndex: number
  ): Promise<ProviderCall>;
}

export interface RuntimeSummaryTraceSpan {
  endedAtMs: number;
  readonly kind: "summary";
  readonly startedAtMs: number;
  status: "completed" | "error" | "running";
}

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
  return JSON.stringify(prompt).includes(
    "[INTERNAL COMPACTION INSTRUCTION - NOT CONVERSATION HISTORY]"
  );
}

export function createRuntimeBlockModelTrace(
  model: RuntimeBlockLanguageModel,
  now: () => number
): RuntimeBlockModelTrace {
  const calls: ProviderCall[] = [];
  const listeners = new Set<() => void>();
  const record = (prompt: unknown): void => {
    const kind = isCompactionProviderPrompt(prompt) ? "summary" : "foreground";
    calls.push({ kind, prompt, startedAtMs: now() });
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
  const supportsStream =
    typeof (model as { readonly doStream?: unknown }).doStream === "function";
  return {
    calls,
    model: wrapLanguageModel({
      middleware: supportsStream
        ? middleware
        : [middleware, simulateStreamingMiddleware()],
      model,
    }),
    waitForCall: async (kind, afterIndex) => {
      const find = () =>
        calls.slice(afterIndex).find((call) => call.kind === kind);
      const existing = find();
      if (existing) {
        return existing;
      }
      return await new Promise<ProviderCall>((resolve) => {
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
  spans: RuntimeSummaryTraceSpan[],
  active: Set<Promise<void>>,
  now: () => number,
  onSummarySettled?: (span: RuntimeSummaryTraceSpan) => void
): AgentCompaction {
  const base = speculativeCompaction({
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
          kind: "summary",
          startedAtMs: now(),
          status: "running",
        };
        const completion = context.summarize(...args).then(
          (summary) => {
            span.endedAtMs = now();
            span.status = "completed";
            onSummarySettled?.(span);
            return summary;
          },
          (error: unknown) => {
            span.endedAtMs = now();
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
