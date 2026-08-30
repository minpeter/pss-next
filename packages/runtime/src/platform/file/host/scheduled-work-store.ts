import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizedListLimit,
  threadPromptScheduledWorkId,
} from "../../../execution/scheduled-work";
import {
  currentDataDirectory,
  migrateLegacyScheduledWork,
} from "../storage/file-execution-store/generation";
import { withFileLock } from "../storage/file-execution-store/lock";
import {
  fileForScheduledWork,
  parseStoredScheduledRunWork,
  parseStoredScheduledThreadPromptWork,
  readJsonFile,
  writeJsonFileIfAbsent,
} from "./scheduled-work-codec";
import type {
  NodeScheduledThreadPrompt,
  NodeScheduledWorkAppendOptions,
  NodeScheduledWorkListOptions,
  ScheduledWorkKind,
  StoredScheduledRunWork,
  StoredScheduledThreadPromptWork,
  StoredScheduledWork,
} from "./scheduled-work-types";

export async function appendScheduledNodeRun(
  directory: string,
  runId: string,
  options: NodeScheduledWorkAppendOptions = {}
): Promise<void> {
  await withScheduledDataDirectory(directory, async (dataDirectory) => {
    await insertScheduledWork(dataDirectory, "run", runId, runId, options);
  });
}

export async function appendScheduledNodeThreadPrompt(
  directory: string,
  prompt: NodeScheduledThreadPrompt
): Promise<void> {
  await withScheduledDataDirectory(directory, async (dataDirectory) => {
    await insertScheduledWork(
      dataDirectory,
      "thread-prompt",
      threadPromptScheduledWorkId(prompt),
      prompt
    );
  });
}

export async function listScheduledNodeRuns(
  directory: string,
  options: NodeScheduledWorkListOptions = {}
): Promise<readonly string[]> {
  return await withScheduledDataDirectory(directory, async (dataDirectory) => {
    const rows = await selectScheduledRunWork(dataDirectory, options);
    return rows.map((row) => row.payload);
  });
}

export async function ackScheduledNodeRun(
  directory: string,
  runId: string
): Promise<void> {
  await withScheduledDataDirectory(directory, async (dataDirectory) => {
    await deleteScheduledWork(dataDirectory, "run", runId);
  });
}

export async function listScheduledNodeThreadPrompts(
  directory: string,
  options: NodeScheduledWorkListOptions = {}
): Promise<readonly NodeScheduledThreadPrompt[]> {
  return await withScheduledDataDirectory(directory, async (dataDirectory) => {
    const rows = await selectScheduledThreadPromptWork(dataDirectory, options);
    return rows.map((row) => row.payload);
  });
}

export async function ackScheduledNodeThreadPrompt(
  directory: string,
  prompt: NodeScheduledThreadPrompt
): Promise<void> {
  await withScheduledDataDirectory(directory, async (dataDirectory) => {
    await deleteScheduledWork(
      dataDirectory,
      "thread-prompt",
      threadPromptScheduledWorkId(prompt)
    );
  });
}

async function insertScheduledWork<T>(
  directory: string,
  kind: ScheduledWorkKind,
  workId: string,
  payload: T,
  options: NodeScheduledWorkAppendOptions = {}
): Promise<void> {
  const file = fileForScheduledWork(directory, kind, workId);
  try {
    await readFile(file, "utf8");
    return;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }

  const createdAt = Date.now();
  await writeJsonFileIfAbsent(file, {
    createdAt,
    dueAt: createdAt + Math.max(0, Math.floor(options.runAfterMs ?? 0)),
    payload,
    workId,
  } satisfies StoredScheduledWork<T>);
}

async function selectScheduledRunWork(
  dataDirectory: string,
  options: NodeScheduledWorkListOptions
): Promise<readonly StoredScheduledRunWork[]> {
  return await selectScheduledWork(
    dataDirectory,
    "run",
    options,
    parseStoredScheduledRunWork
  );
}

async function selectScheduledThreadPromptWork(
  dataDirectory: string,
  options: NodeScheduledWorkListOptions
): Promise<readonly StoredScheduledThreadPromptWork[]> {
  return await selectScheduledWork(
    dataDirectory,
    "thread-prompt",
    options,
    parseStoredScheduledThreadPromptWork
  );
}

async function selectScheduledWork<T>(
  directory: string,
  kind: ScheduledWorkKind,
  options: NodeScheduledWorkListOptions,
  parse: (value: unknown, file: string) => StoredScheduledWork<T>
): Promise<readonly StoredScheduledWork<T>[]> {
  const workDirectory = join(directory, "scheduled-work", kind);
  let entries: readonly string[];
  try {
    entries = await readdir(workDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rows: StoredScheduledWork<T>[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    rows.push(
      await readJsonFile(
        join(workDirectory, entry),
        parse,
        "scheduled work file"
      )
    );
  }

  const limit = normalizedListLimit(options.limit);
  const nowMs = options.nowMs ?? Date.now();
  const sorted = rows.sort(
    (left, right) =>
      left.dueAt - right.dueAt ||
      left.createdAt - right.createdAt ||
      left.workId.localeCompare(right.workId)
  );
  const due = sorted.filter((row) => row.dueAt <= nowMs);
  return limit === undefined ? due : due.slice(0, limit);
}

async function deleteScheduledWork(
  directory: string,
  kind: ScheduledWorkKind,
  workId: string
): Promise<void> {
  await rm(fileForScheduledWork(directory, kind, workId), { force: true });
}

async function withScheduledDataDirectory<T>(
  directory: string,
  operation: (dataDirectory: string) => Promise<T>
): Promise<T> {
  return await withFileLock(
    join(directory, ".execution.lock"),
    "File scheduled work",
    async () => {
      const current = await currentDataDirectory(directory);
      await migrateLegacyScheduledWork(directory, current);
      return await operation(current);
    }
  );
}

import { isNodeError } from "../../../internal/guards";
