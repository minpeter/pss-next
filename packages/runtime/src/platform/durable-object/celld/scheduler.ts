import type { ScheduledThreadPrompt } from "../../../execution/scheduled-work";
import { threadPromptScheduledWorkId } from "../../../execution/scheduled-work";
import type {
  CelldDurableObjectStorage,
  CelldScheduledWorkListOptions,
  CelldScheduler,
  CelldSchedulerOptions,
} from "./scheduler-support";
import {
  DEFAULT_PREFIX,
  insertDueWorkAndArm,
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
        await insertDueWorkAndArm(
          storage,
          prefix,
          RUN_KIND,
          runId,
          runId,
          dueAtMs,
          { runId }
        );
      }),
    resumeThread: (threadKey, options) =>
      serialize(storage, async () => {
        const prompt: ScheduledThreadPrompt = {
          idempotencyKey: options.idempotencyKey,
          notificationId: options.notificationId,
          runId: options.runId,
          threadKey,
        };
        await insertDueWorkAndArm(
          storage,
          prefix,
          THREAD_PROMPT_KIND,
          threadPromptScheduledWorkId(prompt),
          prompt,
          clock(),
          { runId: options.runId, threadKey }
        );
      }),
    storage,
  };
}

export function listCelldScheduledRuns(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly string[]> {
  return Promise.resolve().then(() =>
    listDueWork(storage, RUN_KIND, options, (value) =>
      typeof value === "string" ? value : undefined
    )
  );
}

export function listCelldScheduledThreadPrompts(
  storage: CelldDurableObjectStorage,
  options: CelldScheduledWorkListOptions = {}
): Promise<readonly ScheduledThreadPrompt[]> {
  return Promise.resolve().then(() =>
    listDueWork(storage, THREAD_PROMPT_KIND, options, parseThreadPrompt)
  );
}
