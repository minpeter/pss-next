import type { ScheduledThreadPrompt } from "../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../execution/scheduled-work";
import {
  claimScheduledWork,
  deleteScheduledWork,
} from "../cloudflare/storage/sqlite/scheduled-work-table";
import type {
  CelldDurableObjectStorage,
  CelldScheduledWorkListOptions,
  CelldScheduler,
  CelldSchedulerOptions,
} from "./scheduler-support";
import {
  armNextAlarm,
  DEFAULT_PREFIX,
  insertDueWork,
  listDueWork,
  parseThreadPrompt,
  RUN_KIND,
  serialize,
  THREAD_PROMPT_KIND,
} from "./scheduler-support";

export function createCelldScheduler({
  clock = Date.now,
  prefix = DEFAULT_PREFIX,
  storage,
}: CelldSchedulerOptions): CelldScheduler {
  return {
    enqueueRun: (runId, options = {}) =>
      serialize(storage, async () => {
        const dueAtMs =
          clock() + Math.max(0, Math.floor(options.runAfterMs ?? 0));
        await insertDueWork(storage, prefix, RUN_KIND, runId, runId, dueAtMs, {
          runId,
        });
        await armNextAlarm(storage, prefix);
      }),
    resumeThread: (threadKey, options) =>
      serialize(storage, async () => {
        const prompt: ScheduledThreadPrompt = {
          idempotencyKey: options.idempotencyKey,
          notificationId: options.notificationId,
          runId: options.runId,
          threadKey,
        };
        await insertDueWork(
          storage,
          prefix,
          THREAD_PROMPT_KIND,
          threadPromptScheduledWorkId(prompt),
          prompt,
          clock(),
          { runId: options.runId, threadKey }
        );
        await armNextAlarm(storage, prefix);
      }),
    storage,
  };
}

export function listCelldScheduledRuns(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly string[]> {
  return Promise.resolve(
    listDueWork(storage, RUN_KIND, options, (value) =>
      typeof value === "string" ? value : undefined
    )
  );
}

export function listCelldScheduledThreadPrompts(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly ScheduledThreadPrompt[]> {
  return Promise.resolve(
    listDueWork(storage, THREAD_PROMPT_KIND, options, parseThreadPrompt)
  );
}

export function claimCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<boolean> {
  return serialize(storage, () =>
    claimScheduledWork(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      RUN_KIND,
      runId
    )
  );
}

export function claimCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<boolean> {
  return serialize(storage, () =>
    claimScheduledWork(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      THREAD_PROMPT_KIND,
      threadPromptScheduledWorkId(prompt)
    )
  );
}

export function rearmCelldScheduledWork(
  storage: CelldDurableObjectStorage,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  return serialize(storage, () =>
    armNextAlarm(storage, options.prefix ?? DEFAULT_PREFIX)
  );
}

export function retryCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  delayMs: number,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  return serialize(storage, async () => {
    await insertDueWork(
      storage,
      prefix,
      RUN_KIND,
      runId,
      runId,
      Date.now() + Math.max(0, Math.floor(delayMs)),
      { runId }
    );
    await armNextAlarm(storage, prefix);
  });
}

export function retryCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  return serialize(storage, async () => {
    await insertDueWork(
      storage,
      prefix,
      THREAD_PROMPT_KIND,
      threadPromptScheduledWorkId(prompt),
      prompt,
      Date.now(),
      { runId: prompt.runId, threadKey: prompt.threadKey }
    );
    await armNextAlarm(storage, prefix);
  });
}

export async function ackCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string; readonly rearm?: boolean } = {}
): Promise<void> {
  await serialize(storage, async () => {
    await deleteScheduledWork(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      RUN_KIND,
      runId
    );
    if (options.rearm !== false) {
      await armNextAlarm(storage, options.prefix ?? DEFAULT_PREFIX);
    }
  });
}

export async function ackCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: { readonly prefix?: string; readonly rearm?: boolean } = {}
): Promise<void> {
  await serialize(storage, async () => {
    await deleteScheduledWork(
      storage,
      options.prefix ?? DEFAULT_PREFIX,
      THREAD_PROMPT_KIND,
      threadPromptScheduledWorkId(prompt)
    );
    if (options.rearm !== false) {
      await armNextAlarm(storage, options.prefix ?? DEFAULT_PREFIX);
    }
  });
}
