import { ContextBudgetExceededError } from "../../llm/context-gate";
import type { ModelGenerationOptions } from "../../llm/model-step-types";
import type { ThreadState } from "../state/thread-state";
import { CompactionDeadlineExceededError } from "./auto-compaction-episode";
import { compactThreadBlocking } from "./auto-compaction-runner";
import type {
  ThreadCompactionHandler,
  ThreadContextTransformObserver,
  ThreadModelContextTransform,
} from "./auto-compaction-types";
import type { ThreadExecutionOptions } from "./execution";
import {
  type NormalizedTurnError,
  normalizeTurnError,
} from "./turn-error-metadata";

export async function runAgentLoopWithOverflowCompaction({
  compact,
  execution,
  latestContextTransform,
  model,
  runLoop,
  state,
  signal,
  threadKey,
  transformModelContext,
}: {
  readonly compact?: ThreadCompactionHandler;
  readonly execution: ThreadExecutionOptions;
  readonly latestContextTransform?: ThreadContextTransformObserver;
  readonly model: ModelGenerationOptions;
  readonly runLoop: () => Promise<"aborted" | "completed">;
  readonly state: ThreadState;
  readonly signal?: AbortSignal;
  readonly threadKey: string;
  readonly transformModelContext?: ThreadModelContextTransform;
}): Promise<"aborted" | "completed"> {
  try {
    return await runLoop();
  } catch (error) {
    const gateOverflow = contextGateOverflowMode(error);
    if (gateOverflow === READ_FAILED || gateOverflow === "error") {
      throw error;
    }

    if (!(gateOverflow === "compact" || isContextOverflowError(error))) {
      throw error;
    }

    let compacted = false;
    try {
      compacted = await compactThreadBlocking({
        compact,
        compaction: execution.compaction,
        latestContextTransform,
        model,
        signal,
        state,
        threadKey,
        transformModelContext,
      });
    } catch (compactionError) {
      if (compactionError instanceof CompactionDeadlineExceededError) {
        throw new CompactionDeadlineExceededError({
          cause: sanitizedOverflowTrigger(error),
          deadlineAt: compactionError.deadlineAt,
          deadlineMs: compactionError.deadlineMs,
          reason: compactionError.reason,
        });
      }
      throw compactionError;
    }

    if (!compacted) {
      throw error;
    }

    return await runLoop();
  }
}

function sanitizedOverflowTrigger(error: unknown): NormalizedTurnError {
  const normalized = normalizeTurnError(error);
  return Object.freeze({
    error: Object.freeze({
      ...(normalized.error ?? {}),
      category: "context-overflow" as const,
      version: 1 as const,
    }),
    message: "The request exceeded the context limit.",
  });
}

const MAX_OVERFLOW_ERROR_NODES = 10_000;
const READ_FAILED = Symbol("read-failed");

interface OverflowTraversalBudget {
  remaining: number;
}

function safeRead<T>(read: () => T): T | typeof READ_FAILED {
  try {
    return read();
  } catch {
    return READ_FAILED;
  }
}

function contextGateOverflowMode(
  error: unknown
): "compact" | "error" | false | typeof READ_FAILED {
  const result = safeRead(() =>
    error instanceof ContextBudgetExceededError ? error.onOverflow : false
  );
  return result === false || result === "compact" || result === "error"
    ? result
    : READ_FAILED;
}

function isContextOverflowError(
  error: unknown,
  depth = 0,
  budget: OverflowTraversalBudget = { remaining: MAX_OVERFLOW_ERROR_NODES }
): boolean {
  if (depth > 6 || budget.remaining === 0) {
    return false;
  }
  budget.remaining -= 1;

  if (typeof error === "string") {
    return hasContextOverflowText(error);
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  for (const property of ["name", "code", "message"] as const) {
    const text = errorText(error, property);
    if (text === READ_FAILED) {
      return false;
    }
    if (hasContextOverflowText(text)) {
      return true;
    }
  }

  return hasContextOverflowChild(error, depth, budget);
}

function hasContextOverflowChild(
  error: object,
  depth: number,
  budget: OverflowTraversalBudget
): boolean {
  const cause = safeRead<unknown>(() => Reflect.get(error, "cause"));
  if (cause === READ_FAILED) {
    return false;
  }
  if (
    (typeof cause === "string" ||
      (typeof cause === "object" && cause !== null)) &&
    isContextOverflowError(cause, depth + 1, budget)
  ) {
    return true;
  }

  const errors = safeRead<unknown>(() => Reflect.get(error, "errors"));
  const arrayErrors = safeRead(() =>
    Array.isArray(errors) ? errors : undefined
  );
  if (arrayErrors === READ_FAILED || !arrayErrors) {
    return false;
  }
  const length = safeRead(() => arrayErrors.length);
  if (length === READ_FAILED) {
    return false;
  }
  const firstIndex = Math.max(0, length - budget.remaining);
  for (
    let index = length - 1;
    index >= firstIndex && budget.remaining > 0;
    index -= 1
  ) {
    const child = safeRead<unknown>(() => Reflect.get(arrayErrors, index));
    if (child === READ_FAILED) {
      return false;
    }
    if (isContextOverflowError(child, depth + 1, budget)) {
      return true;
    }
  }
  return false;
}

function hasContextOverflowText(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("context_length_exceeded") ||
    normalized.includes("context length") ||
    normalized.includes("context limit") ||
    normalized.includes("context window") ||
    normalized.includes("maximum context") ||
    normalized.includes("prompt is too long") ||
    normalized.includes("too many tokens") ||
    normalized.includes("token limit")
  );
}

function errorText(
  value: object,
  property: "code" | "message" | "name"
): string | typeof READ_FAILED {
  const field = safeRead<unknown>(() => Reflect.get(value, property));
  if (field === READ_FAILED || typeof field === "string") {
    return field;
  }
  return "";
}
