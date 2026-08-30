import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError, isPlainRecord } from "../../../../internal/guards";
import { readJsonFile } from "./json";
import { parseNotificationRecord, parseRunRecord } from "./schemas";
import { encodeKey } from "./utils";

export async function deleteFileExecutionThread(
  directory: string,
  threadKey: string
): Promise<void> {
  const runIds = await runIdsForThread(directory, threadKey);
  await Promise.all([
    remove(join(directory, "inputs", `${encodeKey(threadKey)}.json`)),
    remove(join(directory, "thread-events", `${encodeKey(threadKey)}.jsonl`)),
    remove(join(directory, "threads", `${encodeKey(threadKey)}.json`)),
    deleteMatchingJsonFiles(join(directory, "notifications"), async (file) => {
      const record = await readJsonFile(
        file,
        parseNotificationRecord,
        "notification file"
      );
      return record?.threadKey === threadKey;
    }),
    deleteMatchingJsonFiles(
      join(directory, "scheduled-work", "thread-prompt"),
      async (file) => (await scheduledThreadKey(file)) === threadKey
    ),
    ...runIds.flatMap((runId) => [
      remove(join(directory, "checkpoints", encodeKey(runId)), true),
      remove(join(directory, "events", `${encodeKey(runId)}.jsonl`)),
      remove(join(directory, "runs", `${encodeKey(runId)}.json`)),
      remove(
        join(directory, "scheduled-work", "run", `${encodeKey(runId)}.json`)
      ),
    ]),
  ]);
}

async function runIdsForThread(
  directory: string,
  threadKey: string
): Promise<readonly string[]> {
  const runDirectory = join(directory, "runs");
  const files = await jsonFiles(runDirectory);
  const runIds: string[] = [];
  for (const file of files) {
    const record = await readJsonFile(file, parseRunRecord, "run file");
    if (record?.threadKey === threadKey) {
      runIds.push(record.runId);
    }
  }
  return runIds;
}

async function deleteMatchingJsonFiles(
  directory: string,
  matches: (file: string) => Promise<boolean>
): Promise<void> {
  for (const file of await jsonFiles(directory)) {
    if (await matches(file)) {
      await remove(file);
    }
  }
}

async function jsonFiles(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => join(directory, entry));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function scheduledThreadKey(file: string): Promise<string> {
  const value = await readJsonFile(file, (parsed) => parsed, "scheduled work");
  if (
    !(isPlainRecord(value) && isPlainRecord(value.payload)) ||
    typeof value.payload.threadKey !== "string"
  ) {
    throw new Error(
      `Invalid Node scheduled work file ${JSON.stringify(
        file
      )}: expected thread prompt payload`
    );
  }
  return value.payload.threadKey;
}

async function remove(file: string, recursive = false): Promise<void> {
  await rm(file, { force: true, recursive });
}
