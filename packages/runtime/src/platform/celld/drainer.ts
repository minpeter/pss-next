import type { TurnRecord, TurnStatus } from "../../execution/host/types";
import {
  normalizedListLimit,
  type ScheduledThreadPrompt,
} from "../../execution/scheduled-work";
import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentTurn } from "../../thread/protocol/turn";
import {
  ackCelldScheduledRun,
  ackCelldScheduledThreadPrompt,
  claimCelldScheduledRun,
  claimCelldScheduledThreadPrompt,
  listCelldScheduledRuns,
  listCelldScheduledThreadPrompts,
  rearmCelldScheduledWork,
  retryCelldScheduledRun,
  retryCelldScheduledThreadPrompt,
} from "./scheduler";
import type { CelldDurableObjectStorage } from "./scheduler-support";

export interface CelldScheduledWorkAgent {
  readonly host: {
    readonly store: {
      readonly turns: {
        get(runId: string): Promise<TurnRecord | null>;
      };
    };
  };
  resume(runId: string): Promise<AgentTurn | null>;
}

export type CelldScheduledWorkRunContext =
  | { readonly kind: "run"; readonly runId: string }
  | {
      readonly idempotencyKey?: string;
      readonly kind: "thread-prompt";
      readonly notificationId?: string;
      readonly runId: string;
      readonly threadKey: string;
    };

export interface CelldScheduledWorkDrainOptions {
  readonly agentForRun: (
    context: CelldScheduledWorkRunContext
  ) => CelldScheduledWorkAgent | Promise<CelldScheduledWorkAgent>;
  readonly limit?: number;
  readonly nowMs?: number;
  readonly onEvent?: (
    context: CelldScheduledWorkRunContext,
    event: AgentEvent
  ) => Promise<void> | void;
  readonly prefix?: string;
  readonly storage: CelldDurableObjectStorage;
}

export interface CelldScheduledWorkDrainResult {
  readonly ackedRuns: readonly string[];
  readonly ackedThreadPrompts: readonly ScheduledThreadPrompt[];
  readonly events: readonly AgentEvent[];
  readonly skippedRuns: readonly string[];
  readonly skippedThreadPrompts: readonly ScheduledThreadPrompt[];
}

interface MutableDrainResult {
  ackedRuns: string[];
  ackedThreadPrompts: ScheduledThreadPrompt[];
  events: AgentEvent[];
  remaining: number | undefined;
  skippedRuns: string[];
  skippedThreadPrompts: ScheduledThreadPrompt[];
}

export async function drainCelldScheduledWork(
  options: CelldScheduledWorkDrainOptions
): Promise<CelldScheduledWorkDrainResult> {
  const result = createDrainResult(options.limit);
  try {
    await drainRuns(options, result);
    if (result.remaining !== 0) {
      await drainThreadPrompts(options, result);
    }
    return result;
  } finally {
    await rearmCelldScheduledWork(
      options.storage,
      prefixOptions(options.prefix)
    );
  }
}

async function drainRuns(
  options: CelldScheduledWorkDrainOptions,
  result: MutableDrainResult
): Promise<void> {
  const { agentForRun, onEvent, prefix, storage } = options;
  for (const runId of await listCelldScheduledRuns(
    storage,
    listOptions(options, result.remaining)
  )) {
    const context = { kind: "run", runId } as const;
    if (
      !(await claimCelldScheduledRun(storage, runId, prefixOptions(prefix)))
    ) {
      result.remaining = decrement(result.remaining);
      continue;
    }
    try {
      if (await resumeAndDrain(agentForRun, context, result.events, onEvent)) {
        await ackCelldScheduledRun(storage, runId, {
          ...prefixOptions(prefix),
          rearm: false,
        });
        result.ackedRuns.push(runId);
      } else {
        await retryCelldScheduledRun(
          storage,
          runId,
          1000,
          prefixOptions(prefix)
        );
        result.skippedRuns.push(runId);
      }
    } catch (error) {
      await retryCelldScheduledRun(storage, runId, 1000, prefixOptions(prefix));
      throw error;
    }
    result.remaining = decrement(result.remaining);
  }
}

async function drainThreadPrompts(
  options: CelldScheduledWorkDrainOptions,
  result: MutableDrainResult
): Promise<void> {
  const { agentForRun, onEvent, prefix, storage } = options;
  for (const prompt of await listCelldScheduledThreadPrompts(
    storage,
    listOptions(options, result.remaining)
  )) {
    if (prompt.runId === undefined) {
      await ackThreadPrompt(storage, prompt, prefix);
      result.ackedThreadPrompts.push(prompt);
      result.remaining = decrement(result.remaining);
      continue;
    }
    const context = threadPromptContext({ ...prompt, runId: prompt.runId });
    if (
      !(await claimCelldScheduledThreadPrompt(
        storage,
        prompt,
        prefixOptions(prefix)
      ))
    ) {
      result.remaining = decrement(result.remaining);
      continue;
    }
    try {
      if (await resumeAndDrain(agentForRun, context, result.events, onEvent)) {
        await ackThreadPrompt(storage, prompt, prefix, false);
        result.ackedThreadPrompts.push(prompt);
      } else {
        await retryCelldScheduledThreadPrompt(
          storage,
          prompt,
          prefixOptions(prefix)
        );
        result.skippedThreadPrompts.push(prompt);
      }
    } catch (error) {
      await retryCelldScheduledThreadPrompt(
        storage,
        prompt,
        prefixOptions(prefix)
      );
      throw error;
    }
    result.remaining = decrement(result.remaining);
  }
}

async function resumeAndDrain(
  agentForRun: CelldScheduledWorkDrainOptions["agentForRun"],
  context: CelldScheduledWorkRunContext,
  events: AgentEvent[],
  onEvent: CelldScheduledWorkDrainOptions["onEvent"]
): Promise<boolean> {
  const agent = await agentForRun(context);
  const turn = await agent.resume(context.runId);
  if (turn === null) {
    const record = await agent.host.store.turns.get(context.runId);
    return record === null || isTerminal(record.status);
  }
  for await (const event of turn.events()) {
    events.push(event);
    await onEvent?.(context, event);
  }
  return true;
}

function createDrainResult(limit: number | undefined): MutableDrainResult {
  return {
    ackedRuns: [],
    ackedThreadPrompts: [],
    events: [],
    remaining: normalizedListLimit(limit),
    skippedRuns: [],
    skippedThreadPrompts: [],
  };
}

function listOptions(
  options: CelldScheduledWorkDrainOptions,
  limit: number | undefined
) {
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };
}

function threadPromptContext(
  prompt: ScheduledThreadPrompt & { readonly runId: string }
): CelldScheduledWorkRunContext {
  return {
    ...(prompt.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: prompt.idempotencyKey }),
    kind: "thread-prompt",
    ...(prompt.notificationId === undefined
      ? {}
      : { notificationId: prompt.notificationId }),
    runId: prompt.runId,
    threadKey: prompt.threadKey,
  };
}

async function ackThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  prefix: string | undefined,
  rearm = true
): Promise<void> {
  await ackCelldScheduledThreadPrompt(storage, prompt, {
    ...prefixOptions(prefix),
    rearm,
  });
}

function prefixOptions(prefix: string | undefined): {
  readonly prefix?: string;
} {
  return prefix === undefined ? {} : { prefix };
}

function decrement(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, value - 1);
}

function isTerminal(status: TurnStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "error";
}
