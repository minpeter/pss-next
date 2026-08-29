import {
  isDefined,
  normalizedListLimit,
  threadPromptScheduledWorkId,
} from "../../../execution/scheduled-work";
import type { DurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import {
  claimScheduledWork,
  deleteScheduledWork,
  insertScheduledWork,
  selectScheduledWork,
} from "../storage/sqlite/scheduled-work-table";
import {
  type DurableObjectScheduledThreadPrompt,
  isCanonicalRunWork,
  isCanonicalThreadPromptWork,
  parseScheduledRunPayload,
  parseScheduledThreadPromptPayload,
  runScheduledWorkId,
} from "./scheduled-work-codec";

export interface ScheduledWorkListOptions {
  readonly limit?: number;
  readonly prefix?: string;
}

export async function appendScheduledRun(
  storage: DurableObjectStorage,
  prefix: string,
  runId: string
): Promise<void> {
  await insertScheduledWork(
    storage,
    prefix,
    "run",
    runScheduledWorkId(runId),
    runId,
    { runId }
  );
}

export async function appendScheduledThreadPrompt(
  storage: DurableObjectStorage,
  prefix: string,
  prompt: DurableObjectScheduledThreadPrompt
): Promise<void> {
  await insertScheduledWork(
    storage,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt),
    prompt,
    { runId: prompt.runId, threadKey: prompt.threadKey }
  );
}

export function listScheduledRuns(
  storage: DurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly string[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    selectCanonicalScheduledWork({
      kind: "run",
      limit: options.limit,
      parse: (row) =>
        isCanonicalRunWork(row)
          ? parseScheduledRunPayload(row.payload)
          : undefined,
      prefix,
      storage,
    })
  );
}

export function ackScheduledRun(
  storage: DurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  return deleteScheduledWork(storage, prefix, "run", runScheduledWorkId(runId));
}

export async function claimScheduledRun(
  storage: DurableObjectStorage,
  runId: string,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<boolean> {
  const prefix = options.prefix ?? defaultPrefix;
  return await claimScheduledWork(
    storage,
    prefix,
    "run",
    runScheduledWorkId(runId)
  );
}

export function listScheduledThreadPrompts(
  storage: DurableObjectStorage,
  options: ScheduledWorkListOptions,
  defaultPrefix: string
): Promise<readonly DurableObjectScheduledThreadPrompt[]> {
  const prefix = options.prefix ?? defaultPrefix;
  return Promise.resolve(
    selectCanonicalScheduledWork({
      kind: "thread-prompt",
      limit: options.limit,
      parse: (row) =>
        isCanonicalThreadPromptWork(row)
          ? parseScheduledThreadPromptPayload(row.payload)
          : undefined,
      prefix,
      storage,
    })
  );
}

function selectCanonicalScheduledWork<T>({
  kind,
  limit,
  parse,
  prefix,
  storage,
}: {
  readonly kind: "run" | "thread-prompt";
  readonly limit?: number;
  readonly parse: (
    row: ReturnType<typeof selectScheduledWork>[number]
  ) => T | undefined;
  readonly prefix: string;
  readonly storage: DurableObjectStorage;
}): T[] {
  const normalized = normalizedListLimit(limit);
  if (normalized === 0) {
    return [];
  }
  if (normalized === undefined) {
    return selectScheduledWork(storage, prefix, kind)
      .map(parse)
      .filter(isDefined);
  }

  const values: T[] = [];
  let offset = 0;
  while (values.length < normalized) {
    const rows = selectScheduledWork(storage, prefix, kind, normalized, offset);
    if (rows.length === 0) {
      return values;
    }
    values.push(...rows.map(parse).filter(isDefined));
    offset += rows.length;
  }
  return values.slice(0, normalized);
}

export function ackScheduledThreadPrompt(
  storage: DurableObjectStorage,
  prompt: DurableObjectScheduledThreadPrompt,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<void> {
  const prefix = options.prefix ?? defaultPrefix;
  return deleteScheduledWork(
    storage,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
}

export async function claimScheduledThreadPrompt(
  storage: DurableObjectStorage,
  prompt: DurableObjectScheduledThreadPrompt,
  options: { readonly prefix?: string },
  defaultPrefix: string
): Promise<boolean> {
  const prefix = options.prefix ?? defaultPrefix;
  return await claimScheduledWork(
    storage,
    prefix,
    "thread-prompt",
    threadPromptScheduledWorkId(prompt)
  );
}
