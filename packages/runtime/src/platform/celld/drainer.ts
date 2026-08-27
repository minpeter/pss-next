import type { TurnRecord } from "../../execution/host/types";
import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";
import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentTurn } from "../../thread/protocol/turn";
import {
  ackThreadPrompt,
  createDrainResult,
  decrement,
  isTerminal,
  listOptions,
  type MutableDrainResult,
  threadPromptContext,
  workOptions,
} from "./drainer-support";
import {
  listCelldScheduledRuns,
  listCelldScheduledThreadPrompts,
} from "./scheduler";
import {
  ackCelldScheduledRun,
  claimCelldScheduledRun,
  claimCelldScheduledThreadPrompt,
  rearmCelldScheduledWork,
  retryCelldScheduledRun,
  retryCelldScheduledThreadPrompt,
} from "./scheduler-claims";
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
    await rearmCelldScheduledWork(options.storage, workOptions(options));
  }
}
async function drainRuns(
  options: CelldScheduledWorkDrainOptions,
  result: MutableDrainResult
): Promise<void> {
  const { agentForRun, onEvent, storage } = options;
  for (const runId of await listCelldScheduledRuns(
    storage,
    listOptions(options, result.remaining)
  )) {
    const context = { kind: "run", runId } as const;
    const claimToken = await claimCelldScheduledRun(
      storage,
      runId,
      workOptions(options)
    );
    if (claimToken === undefined) {
      result.remaining = decrement(result.remaining);
      continue;
    }
    try {
      if (await resumeAndDrain(agentForRun, context, result.events, onEvent)) {
        await ackCelldScheduledRun(storage, runId, {
          ...workOptions(options),
          claimToken,
          rearm: false,
        });
        result.ackedRuns.push(runId);
      } else {
        await retryCelldScheduledRun(
          storage,
          runId,
          1000,
          workOptions(options, claimToken)
        );
        result.skippedRuns.push(runId);
      }
    } catch (error) {
      await retryCelldScheduledRun(
        storage,
        runId,
        1000,
        workOptions(options, claimToken)
      );
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
    const claimToken = await claimCelldScheduledThreadPrompt(
      storage,
      prompt,
      workOptions(options)
    );
    if (claimToken === undefined) {
      result.remaining = decrement(result.remaining);
      continue;
    }
    try {
      if (await resumeAndDrain(agentForRun, context, result.events, onEvent)) {
        await ackThreadPrompt(storage, prompt, prefix, false, claimToken);
        result.ackedThreadPrompts.push(prompt);
      } else {
        await retryCelldScheduledThreadPrompt(
          storage,
          prompt,
          workOptions(options, claimToken)
        );
        result.skippedThreadPrompts.push(prompt);
      }
    } catch (error) {
      await retryCelldScheduledThreadPrompt(
        storage,
        prompt,
        workOptions(options, claimToken)
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
