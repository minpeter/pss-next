import type { TurnStatus } from "../../../execution/host/types";
import {
  normalizedListLimit,
  type ScheduledThreadPrompt,
} from "../../../execution/scheduled-work";
import type { AgentEvent } from "../../../thread/protocol/events";
import type {
  CelldScheduledWorkDrainOptions,
  CelldScheduledWorkRunContext,
} from "./drainer";
import { ackCelldScheduledThreadPrompt } from "./scheduler-claims";
import type { CelldDurableObjectStorage } from "./scheduler-support";

export interface MutableDrainResult {
  ackedRuns: string[];
  ackedThreadPrompts: ScheduledThreadPrompt[];
  events: AgentEvent[];
  remaining: number | undefined;
  skippedRuns: string[];
  skippedThreadPrompts: ScheduledThreadPrompt[];
}

export function createDrainResult(
  limit: number | undefined
): MutableDrainResult {
  return {
    ackedRuns: [],
    ackedThreadPrompts: [],
    events: [],
    remaining: normalizedListLimit(limit),
    skippedRuns: [],
    skippedThreadPrompts: [],
  };
}

export function listOptions(
  options: CelldScheduledWorkDrainOptions,
  limit: number | undefined
) {
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };
}

export function threadPromptContext(
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

export async function ackThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  prefix: string | undefined,
  rearm = true,
  claimToken?: string
): Promise<void> {
  await ackCelldScheduledThreadPrompt(storage, prompt, {
    claimToken,
    ...prefixOptions(prefix),
    rearm,
  });
}

export function prefixOptions(prefix: string | undefined): {
  readonly prefix?: string;
} {
  return prefix === undefined ? {} : { prefix };
}

export function workOptions(
  options: Pick<CelldScheduledWorkDrainOptions, "nowMs" | "prefix">,
  claimToken?: string
): {
  readonly claimToken?: string;
  readonly nowMs?: number;
  readonly prefix?: string;
} {
  return {
    ...(claimToken === undefined ? {} : { claimToken }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...prefixOptions(options.prefix),
  };
}

export function decrement(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, value - 1);
}

export function isTerminal(status: TurnStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "error";
}
