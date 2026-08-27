import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../execution/scheduled-work";
import {
  ackScheduledWorkLease,
  claimScheduledWorkLease,
  releaseScheduledWorkLease,
} from "../cloudflare/storage/sqlite/scheduled-work-claims";
import { deleteScheduledWork } from "../cloudflare/storage/sqlite/scheduled-work-table";
import type { CelldDurableObjectStorage } from "./scheduler-support";
import {
  armNextAlarm,
  DEFAULT_PREFIX,
  insertDueWork,
  RUN_KIND,
  serialize,
  THREAD_PROMPT_KIND,
} from "./scheduler-support";

interface ClaimOptions {
  readonly leaseMs?: number;
  readonly nowMs?: number;
  readonly prefix?: string;
}

interface MutationOptions {
  readonly claimToken?: string;
  readonly nowMs?: number;
  readonly prefix?: string;
  readonly rearm?: boolean;
}

export function claimCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: ClaimOptions = {}
): Promise<string | undefined> {
  return serialize(storage, () =>
    claimScheduledWorkLease(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      RUN_KIND,
      runId,
      options.nowMs,
      options.leaseMs
    )
  );
}

export function claimCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: ClaimOptions = {}
): Promise<string | undefined> {
  return serialize(storage, () =>
    claimScheduledWorkLease(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      THREAD_PROMPT_KIND,
      threadPromptScheduledWorkId(prompt),
      options.nowMs,
      options.leaseMs
    )
  );
}

export function rearmCelldScheduledWork(
  storage: CelldDurableObjectStorage,
  options: ClaimOptions = {}
): Promise<void> {
  return serialize(storage, () =>
    armNextAlarm(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      options.nowMs ?? Date.now()
    )
  );
}

export function retryCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  delayMs: number,
  options: MutationOptions = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  return serialize(storage, async () => {
    if (options.claimToken === undefined) {
      await insertDueWork(
        storage,
        prefix,
        RUN_KIND,
        runId,
        runId,
        nowMs + Math.max(0, Math.floor(delayMs)),
        { runId }
      );
    } else {
      await releaseScheduledWorkLease(
        storage,
        prefix,
        RUN_KIND,
        runId,
        options.claimToken,
        nowMs + Math.max(0, Math.floor(delayMs))
      );
    }
    await armNextAlarm(storage, prefix, nowMs);
  });
}

export function retryCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: MutationOptions = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  return serialize(storage, async () => {
    if (options.claimToken === undefined) {
      await insertDueWork(
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        prompt,
        nowMs,
        { runId: prompt.runId, threadKey: prompt.threadKey }
      );
    } else {
      await releaseScheduledWorkLease(
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        options.claimToken,
        nowMs
      );
    }
    await armNextAlarm(storage, prefix, nowMs);
  });
}

export async function ackCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: MutationOptions = {}
): Promise<void> {
  await serialize(storage, async () => {
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (options.claimToken === undefined) {
      await deleteScheduledWork(storage, prefix, RUN_KIND, runId);
    } else {
      await ackScheduledWorkLease(
        storage,
        prefix,
        RUN_KIND,
        runId,
        options.claimToken
      );
    }
    if (options.rearm !== false) {
      await armNextAlarm(storage, prefix, options.nowMs ?? Date.now());
    }
  });
}

export async function ackCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: MutationOptions = {}
): Promise<void> {
  await serialize(storage, async () => {
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (options.claimToken === undefined) {
      await deleteScheduledWork(
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt)
      );
    } else {
      await ackScheduledWorkLease(
        storage,
        prefix,
        THREAD_PROMPT_KIND,
        threadPromptScheduledWorkId(prompt),
        options.claimToken
      );
    }
    if (options.rearm !== false) {
      await armNextAlarm(storage, prefix, options.nowMs ?? Date.now());
    }
  });
}
