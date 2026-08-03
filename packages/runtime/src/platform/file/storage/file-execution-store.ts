import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointStore,
  EventStore,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../execution/host/types";
import type { ThreadStore } from "../../../thread/store/types";
import {
  copyDataDirectories,
  currentDataDirectory,
  GENERATIONS_DIRECTORY,
  writeCurrentGeneration,
} from "./file-execution-store/generation";
import {
  createFileExecutionLock,
  withFileLock,
} from "./file-execution-store/lock";
import { createFileExecutionStorePorts } from "./file-execution-store/ports";

/**
 * A file-backed store for processes on one host using a local filesystem.
 * Its locking relies on host PIDs and local atomic filesystem operations; do
 * not share the directory between hosts or over a network filesystem.
 */
export class FileExecutionStore implements HostStore {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly inputs: ThreadInputInbox;
  readonly notifications: NotificationInbox;
  readonly threadEvents: ThreadEventLog;
  readonly turns: TurnStore;
  readonly threads: ThreadStore;

  readonly #directory: string;
  readonly #lockDirectory: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#lockDirectory = join(directory, ".execution.lock");
    const ports = createFileExecutionStorePorts(
      () => currentDataDirectory(directory),
      createFileExecutionLock(this.#lockDirectory, "auto")
    );

    this.turns = ports.turns;
    this.events = ports.events;
    this.checkpoints = ports.checkpoints;
    this.inputs = ports.inputs;
    this.notifications = ports.notifications;
    this.threadEvents = assertFileThreadEvents(ports.threadEvents);
    this.threads = ports.threads;
  }

  async transaction<T>(
    fn: (tx: HostStoreTransaction) => Promise<T>
  ): Promise<T> {
    return await withFileLock(
      this.#lockDirectory,
      "FileExecutionStore transaction",
      async () => {
        await mkdir(this.#directory, { recursive: true });
        const generationId = `transaction-${process.pid}-${randomUUID()}`;
        const transactionDirectory = join(
          this.#directory,
          GENERATIONS_DIRECTORY,
          generationId
        );
        await mkdir(transactionDirectory, { recursive: true });

        let committed = false;
        try {
          await copyDataDirectories(
            await currentDataDirectory(this.#directory),
            transactionDirectory
          );
          const tx = createFileExecutionStorePorts(
            () => Promise.resolve(transactionDirectory),
            createFileExecutionLock(this.#lockDirectory, "held")
          );
          const result = await fn(tx);
          await writeCurrentGeneration(this.#directory, generationId);
          committed = true;
          return result;
        } finally {
          if (!committed) {
            await rm(transactionDirectory, { force: true, recursive: true });
          }
        }
      }
    );
  }
}

function assertFileThreadEvents(
  threadEvents: ThreadEventLog | undefined
): ThreadEventLog {
  if (!threadEvents) {
    throw new Error("FileExecutionStore requires a thread event log");
  }
  return threadEvents;
}
