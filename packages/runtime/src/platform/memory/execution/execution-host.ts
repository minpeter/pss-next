import { noopRuntimeDiagnostics } from "../../../diagnostics";
import type { ResumeThreadOptions } from "../../../execution/host/scheduler-options";
import type { AgentHost, HostScheduler } from "../../../execution/host/types";
import {
  applyListLimit,
  type ScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../../execution/scheduled-work";
import { MemoryAttachmentStore } from "../storage/memory-attachment-store";
import { InMemoryExecutionStore } from "./store";

export type MemoryScheduledThreadPrompt = ScheduledThreadPrompt;

export interface MemoryScheduledWorkListOptions {
  readonly limit?: number;
  readonly nowMs?: number;
}

export interface InMemoryHost extends AgentHost {
  readonly scheduler: InMemoryExecutionScheduler;
}

export function createInMemoryHost(): InMemoryHost {
  return {
    attachmentStore: new MemoryAttachmentStore(),
    diagnostics: noopRuntimeDiagnostics,
    store: new InMemoryExecutionStore(),
    scheduler: new InMemoryExecutionScheduler(),
  };
}

interface StoredScheduledWork<T> {
  readonly createdAt: number;
  readonly dueAt: number;
  readonly payload: T;
  readonly workId: string;
}

export class InMemoryExecutionScheduler implements HostScheduler {
  readonly #runs = new Map<string, StoredScheduledWork<string>>();
  readonly #threadPrompts = new Map<
    string,
    StoredScheduledWork<MemoryScheduledThreadPrompt>
  >();

  enqueueRun(
    runId: string,
    options: { readonly runAfterMs?: number } = {}
  ): Promise<void> {
    insertScheduledWork(this.#runs, runId, runId, options.runAfterMs);
    return Promise.resolve();
  }

  resumeThread(threadKey: string, options: ResumeThreadOptions): Promise<void> {
    const prompt: MemoryScheduledThreadPrompt = {
      idempotencyKey: options.idempotencyKey,
      notificationId: options.notificationId,
      runId: options.runId,
      threadKey,
    };
    insertScheduledWork(
      this.#threadPrompts,
      threadPromptScheduledWorkId(prompt),
      prompt,
      0
    );
    return Promise.resolve();
  }

  listScheduledRuns(
    options: MemoryScheduledWorkListOptions = {}
  ): Promise<readonly string[]> {
    return Promise.resolve(listDueScheduledWork(this.#runs, options));
  }

  listScheduledThreadPrompts(
    options: MemoryScheduledWorkListOptions = {}
  ): Promise<readonly MemoryScheduledThreadPrompt[]> {
    return Promise.resolve(listDueScheduledWork(this.#threadPrompts, options));
  }

  ackScheduledRun(runId: string): Promise<void> {
    this.#runs.delete(runId);
    return Promise.resolve();
  }

  ackScheduledThreadPrompt(prompt: MemoryScheduledThreadPrompt): Promise<void> {
    this.#threadPrompts.delete(threadPromptScheduledWorkId(prompt));
    return Promise.resolve();
  }
}

function insertScheduledWork<T>(
  work: Map<string, StoredScheduledWork<T>>,
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
  work: Map<string, StoredScheduledWork<T>>,
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
    due.map((row) => row.payload),
    options.limit
  );
}
