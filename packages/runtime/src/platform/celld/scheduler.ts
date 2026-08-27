import type { HostScheduler } from "../../execution";
import {
  isScheduledThreadPrompt,
  type ScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../execution/scheduled-work";
import type { CloudflareDurableObjectStorage } from "../cloudflare";
import {
  deleteScheduledWork,
  insertScheduledWork,
  selectScheduledWork,
} from "../cloudflare/storage/sqlite/scheduled-work-table";

const DEFAULT_PREFIX = "pss-runtime";
const RUN_KIND = "celld-run";
const THREAD_PROMPT_KIND = "celld-thread-prompt";

export interface CelldDurableObjectStorage
  extends CloudflareDurableObjectStorage {
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: Date | number): Promise<void>;
}

export interface CelldScheduledWorkListOptions {
  readonly limit?: number;
  readonly nowMs?: number;
  readonly prefix?: string;
}

export interface CelldSchedulerOptions {
  readonly clock?: () => number;
  readonly prefix?: string;
  readonly storage: CelldDurableObjectStorage;
}

export interface CelldScheduler extends HostScheduler {
  readonly storage: CelldDurableObjectStorage;
}

interface DuePayload<T> {
  readonly dueAtMs: number;
  readonly value: T;
}

export function createCelldScheduler({
  clock = Date.now,
  prefix = DEFAULT_PREFIX,
  storage,
}: CelldSchedulerOptions): CelldScheduler {
  return {
    enqueueRun: async (runId, options = {}) => {
      const dueAtMs =
        clock() + Math.max(0, Math.floor(options.runAfterMs ?? 0));
      await insertDueWork(storage, prefix, RUN_KIND, runId, runId, dueAtMs, {
        runId,
      });
      await armNextAlarm(storage, prefix);
    },
    resumeThread: async (threadKey, options) => {
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
    },
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
    listDueWork(storage, THREAD_PROMPT_KIND, options, (value) =>
      isScheduledThreadPrompt(value) ? value : undefined
    )
  );
}

export async function ackCelldScheduledRun(
  storage: CelldDurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  await deleteScheduledWork(storage, prefix, RUN_KIND, runId);
  await armNextAlarm(storage, prefix);
}

export async function ackCelldScheduledThreadPrompt(
  storage: CelldDurableObjectStorage,
  prompt: ScheduledThreadPrompt,
  options: { readonly prefix?: string } = {}
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  await deleteScheduledWork(
    storage,
    prefix,
    THREAD_PROMPT_KIND,
    threadPromptScheduledWorkId(prompt)
  );
  await armNextAlarm(storage, prefix);
}

async function insertDueWork<T>(
  storage: CelldDurableObjectStorage,
  prefix: string,
  kind: typeof RUN_KIND | typeof THREAD_PROMPT_KIND,
  workId: string,
  value: T,
  dueAtMs: number,
  indexes: { readonly runId?: string; readonly threadKey?: string }
): Promise<void> {
  await insertScheduledWork(
    storage,
    prefix,
    kind,
    workId,
    { dueAtMs, value } satisfies DuePayload<T>,
    indexes
  );
}

function listDueWork<T>(
  storage: CelldDurableObjectStorage,
  kind: typeof RUN_KIND | typeof THREAD_PROMPT_KIND,
  options: CelldScheduledWorkListOptions,
  parseValue: (value: unknown) => T | undefined
): T[] {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const nowMs = options.nowMs ?? Date.now();
  const limit = normalizeLimit(options.limit);
  if (limit === 0) {
    return [];
  }
  const values = selectScheduledWork(storage, prefix, kind)
    .map((row) => parseDuePayload(row.payload))
    .flatMap((value) => {
      if (value === undefined) {
        return [];
      }
      const parsed = parseValue(value.value);
      return parsed === undefined
        ? []
        : [{ dueAtMs: value.dueAtMs, value: parsed }];
    })
    .filter((value) => value.dueAtMs <= nowMs)
    .sort((left, right) => left.dueAtMs - right.dueAtMs);
  return values.slice(0, limit).map((value) => value.value);
}

async function armNextAlarm(
  storage: CelldDurableObjectStorage,
  prefix: string
): Promise<void> {
  const dueAtMs = earliestDueAt(storage, prefix);
  if (dueAtMs === undefined) {
    await storage.deleteAlarm();
    return;
  }
  if ((await storage.getAlarm()) !== dueAtMs) {
    await storage.setAlarm(dueAtMs);
  }
}

function earliestDueAt(
  storage: CelldDurableObjectStorage,
  prefix: string
): number | undefined {
  const values = ([RUN_KIND, THREAD_PROMPT_KIND] as const).flatMap((kind) =>
    selectScheduledWork(storage, prefix, kind)
      .map((row) => parseDuePayload(row.payload)?.dueAtMs)
      .filter((value): value is number => value !== undefined)
  );
  return values.length === 0 ? undefined : Math.min(...values);
}

function parseDuePayload(payload: string): DuePayload<unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value === "object" &&
      value !== null &&
      "dueAtMs" in value &&
      typeof value.dueAtMs === "number" &&
      Number.isFinite(value.dueAtMs) &&
      "value" in value
    ) {
      return { dueAtMs: value.dueAtMs, value: value.value };
    }
  } catch {
    return;
  }
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}
