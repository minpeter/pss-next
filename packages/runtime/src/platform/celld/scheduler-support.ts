import type { HostScheduler } from "../../execution";
import {
  isScheduledThreadPrompt,
  type ScheduledThreadPrompt,
} from "../../execution/scheduled-work";
import type { CloudflareDurableObjectStorage } from "../cloudflare/host/durable-object-host";
import {
  insertScheduledWork,
  selectScheduledWork,
} from "../cloudflare/storage/sqlite/scheduled-work-table";

export const DEFAULT_PREFIX = "pss-runtime";
export const RUN_KIND = "celld-run";
export const THREAD_PROMPT_KIND = "celld-thread-prompt";
export const storageOperations = new WeakMap<object, Promise<void>>();

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

export interface CelldDurableObjectStorage
  extends CloudflareDurableObjectStorage {
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: Date | number): Promise<void>;
}

interface DuePayload<T> {
  readonly dueAtMs: number;
  readonly value: T;
}

export function serialize<T>(
  storage: CelldDurableObjectStorage,
  operation: () => Promise<T>
): Promise<T> {
  const previous = storageOperations.get(storage) ?? Promise.resolve();
  const current = previous.then(operation);
  storageOperations.set(
    storage,
    current.then(
      () => undefined,
      () => undefined
    )
  );
  return current;
}

export async function insertDueWork<T>(
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

export function listDueWork<T>(
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
  return selectScheduledWork(storage, prefix, kind)
    .filter(
      (row) =>
        row.claimed_until === undefined ||
        row.claimed_until === null ||
        row.claimed_until <= nowMs
    )
    .map((row) => requiredDuePayload(row.payload))
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
    .sort((left, right) => left.dueAtMs - right.dueAtMs)
    .slice(0, limit)
    .map((value) => value.value);
}

export async function armNextAlarm(
  storage: CelldDurableObjectStorage,
  prefix: string,
  nowMs = Date.now()
): Promise<void> {
  const dueAtMs = earliestDueAt(storage, prefix, nowMs);
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
  prefix: string,
  nowMs: number
): number | undefined {
  const values = ([RUN_KIND, THREAD_PROMPT_KIND] as const).flatMap((kind) =>
    selectScheduledWork(storage, prefix, kind)
      .map((row) => {
        if (
          typeof row.claimed_until === "number" &&
          row.claimed_until > nowMs
        ) {
          return row.claimed_until;
        }
        return requiredDuePayload(row.payload).dueAtMs;
      })
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

function requiredDuePayload(payload: string): DuePayload<unknown> {
  const value = parseDuePayload(payload);
  if (value === undefined) {
    throw new Error("Invalid Celld scheduled work payload.");
  }
  return value;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}

export function parseThreadPrompt(
  value: unknown
): ScheduledThreadPrompt | undefined {
  return isScheduledThreadPrompt(value) ? value : undefined;
}
