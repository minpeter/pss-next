import type { HostScheduler } from "../../execution";
import {
  isScheduledThreadPrompt,
  type ScheduledThreadPrompt,
} from "../../execution/scheduled-work";
import type { CloudflareDurableObjectStorage } from "../cloudflare/host/durable-object-host";
import {
  requiredSqlStorage,
  withTransaction,
} from "../cloudflare/storage/durable-object/sql-access";
import {
  insertScheduledWorkInTransaction,
  selectNextScheduledWork,
  selectScheduledWorkDue,
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

export async function insertDueWorkAndArm<T>(
  storage: CelldDurableObjectStorage,
  prefix: string,
  kind: typeof RUN_KIND | typeof THREAD_PROMPT_KIND,
  workId: string,
  value: T,
  dueAtMs: number,
  indexes: { readonly runId?: string; readonly threadKey?: string }
): Promise<void> {
  const currentAlarm = await storage.getAlarm();
  await withTransaction(storage, async (transaction) => {
    insertScheduledWorkInTransaction(
      transaction,
      prefix,
      kind,
      workId,
      { dueAtMs, value } satisfies DuePayload<T>,
      { ...indexes, dueAtMs }
    );
    if (transaction.setAlarm === undefined) {
      throw new Error("Celld storage transaction setAlarm() is required.");
    }
    const sql = requiredSqlStorage(transaction, "Celld scheduled work alarm");
    const persistedDueAt = ([RUN_KIND, THREAD_PROMPT_KIND] as const)
      .flatMap((scheduledKind) => {
        const row = sql
          .exec<{ readonly due_at: number | null }>(
            "SELECT due_at FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND due_at IS NOT NULL ORDER BY due_at, rowid LIMIT 1",
            prefix,
            scheduledKind
          )
          .toArray()[0];
        return typeof row?.due_at === "number" ? [row.due_at] : [];
      })
      .reduce((earliest, value) => Math.min(earliest, value), dueAtMs);
    await transaction.setAlarm(
      currentAlarm === null
        ? persistedDueAt
        : Math.min(currentAlarm, persistedDueAt)
    );
  });
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
  return selectScheduledWorkDue(storage, prefix, kind, nowMs, limit)
    .map((row) => requiredDuePayload(row.payload))
    .flatMap((value) => {
      const parsed = parseValue(value.value);
      if (parsed === undefined) {
        throw new Error("Invalid Celld scheduled work value.");
      }
      return [parsed];
    });
}

export async function armNextAlarm(
  storage: CelldDurableObjectStorage,
  prefix: string,
  _nowMs = Date.now()
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
  const values = ([RUN_KIND, THREAD_PROMPT_KIND] as const).flatMap((kind) => {
    const row = selectNextScheduledWork(storage, prefix, kind);
    return typeof row?.due_at === "number" ? [row.due_at] : [];
  });
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
