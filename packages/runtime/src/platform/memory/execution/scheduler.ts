import type { ResumeThreadOptions } from "../../../execution/host/scheduler-options";
import type { HostScheduler } from "../../../execution/host/types";
import {
  applyListLimit,
  type ScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../../execution/scheduled-work";
import {
  createEmptyScheduledState,
  type MemoryScheduledState,
  type StoredMemoryScheduledWork,
} from "./scheduled-state";

export type MemoryScheduledThreadPrompt = ScheduledThreadPrompt;

export interface MemoryScheduledWorkListOptions {
  readonly limit?: number;
  readonly nowMs?: number;
}

interface SchedulerBinding {
  readonly mutate: <T>(
    operation: (state: MemoryScheduledState) => T
  ) => Promise<T>;
  readonly read: () => MemoryScheduledState;
}

const schedulerBindings = new WeakMap<
  InMemoryExecutionScheduler,
  SchedulerBinding
>();

export class InMemoryExecutionScheduler implements HostScheduler {
  constructor() {
    const state = createEmptyScheduledState();
    schedulerBindings.set(this, {
      mutate: (operation) => Promise.resolve(operation(state)),
      read: () => state,
    });
  }

  async enqueueRun(
    runId: string,
    options: { readonly runAfterMs?: number } = {}
  ): Promise<void> {
    await bindingFor(this).mutate((state) => {
      insertScheduledWork(state.runs, runId, runId, options.runAfterMs);
    });
  }

  async resumeThread(
    threadKey: string,
    options: ResumeThreadOptions
  ): Promise<void> {
    const prompt: MemoryScheduledThreadPrompt = {
      idempotencyKey: options.idempotencyKey,
      notificationId: options.notificationId,
      runId: options.runId,
      threadKey,
    };
    await bindingFor(this).mutate((state) => {
      insertScheduledWork(
        state.threadPrompts,
        threadPromptScheduledWorkId(prompt),
        prompt,
        0
      );
    });
  }

  listScheduledRuns(
    options: MemoryScheduledWorkListOptions = {}
  ): Promise<readonly string[]> {
    return Promise.resolve(
      listDueScheduledWork(bindingFor(this).read().runs, options)
    );
  }

  listScheduledThreadPrompts(
    options: MemoryScheduledWorkListOptions = {}
  ): Promise<readonly MemoryScheduledThreadPrompt[]> {
    return Promise.resolve(
      listDueScheduledWork(bindingFor(this).read().threadPrompts, options)
    );
  }

  async ackScheduledRun(runId: string): Promise<void> {
    await bindingFor(this).mutate((state) => {
      state.runs.delete(runId);
    });
  }

  async ackScheduledThreadPrompt(
    prompt: MemoryScheduledThreadPrompt
  ): Promise<void> {
    await bindingFor(this).mutate((state) => {
      state.threadPrompts.delete(threadPromptScheduledWorkId(prompt));
    });
  }
}

export function createBoundInMemoryExecutionScheduler(
  binding: SchedulerBinding
): InMemoryExecutionScheduler {
  const scheduler = new InMemoryExecutionScheduler();
  schedulerBindings.set(scheduler, binding);
  return scheduler;
}

function bindingFor(scheduler: InMemoryExecutionScheduler): SchedulerBinding {
  const binding = schedulerBindings.get(scheduler);
  if (!binding) {
    throw new Error("In-memory scheduler binding is unavailable.");
  }
  return binding;
}

function insertScheduledWork<T>(
  work: Map<string, StoredMemoryScheduledWork<T>>,
  workId: string,
  payload: T,
  runAfterMs: number | undefined
): void {
  if (work.has(workId)) {
    return;
  }
  const createdAt = Date.now();
  work.set(workId, {
    createdAt,
    dueAt: createdAt + Math.max(0, Math.floor(runAfterMs ?? 0)),
    payload,
    workId,
  });
}

function listDueScheduledWork<T>(
  work: ReadonlyMap<string, StoredMemoryScheduledWork<T>>,
  options: MemoryScheduledWorkListOptions
): T[] {
  const nowMs = options.nowMs ?? Date.now();
  const due = [...work.values()]
    .filter((row) => row.dueAt <= nowMs)
    .sort(
      (left, right) =>
        left.dueAt - right.dueAt ||
        left.createdAt - right.createdAt ||
        left.workId.localeCompare(right.workId)
    );
  return applyListLimit(
    due.map((row) => structuredClone(row.payload)),
    options.limit
  );
}
