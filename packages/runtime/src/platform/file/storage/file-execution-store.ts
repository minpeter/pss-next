import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendLeaseFencedCheckpoint } from "../../../execution/host/checkpoint-fencing";
import type {
  CheckpointStore,
  EventStore,
  HostStore,
  HostStoreTransaction,
  LeaseFencedCheckpointStore,
  NotificationInbox,
  ThreadEventLog,
  ThreadInputInbox,
  TurnStore,
} from "../../../execution/host/types";
import type { ThreadStore } from "../../../thread/store/types";
import { deleteFileExecutionThread } from "./file-execution-store/delete-thread";
import {
  copyDataDirectories,
  currentDataDirectory,
  GENERATIONS_DIRECTORY,
  migrateLegacyScheduledWork,
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
  readonly leaseFencedCheckpoints: LeaseFencedCheckpointStore;
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
    this.checkpoints = {
      append: async (checkpoint, options) =>
        await this.transaction(
          async (tx) => await tx.checkpoints.append(checkpoint, options)
        ),
      latest: async (runId) => await ports.checkpoints.latest(runId),
    };
    this.leaseFencedCheckpoints = {
      appendFenced: async (checkpoint, options) =>
        await this.transaction(
          async (tx) =>
            await appendLeaseFencedCheckpoint(tx, checkpoint, options)
        ),
    };
    this.inputs = ports.inputs;
    this.notifications = ports.notifications;
    this.threadEvents = assertFileThreadEvents(ports.threadEvents);
    this.threads = ports.threads;
  }

  async deleteThread(threadKey: string): Promise<void> {
    await this.#commitGeneration(async (directory) => {
      await deleteFileExecutionThread(directory, threadKey);
    });
  }

  async transaction<T>(
    fn: (tx: HostStoreTransaction) => Promise<T>
  ): Promise<T> {
    return await this.#commitGeneration(async (directory) => {
      const tx = createFileExecutionStorePorts(
        () => Promise.resolve(directory),
        createFileExecutionLock(this.#lockDirectory, "held")
      );
      return await fn(tx);
    });
  }

  async #commitGeneration<T>(
    operation: (directory: string) => Promise<T>
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
          const currentDirectory = await currentDataDirectory(this.#directory);
          await migrateLegacyScheduledWork(this.#directory, currentDirectory);
          await copyDataDirectories(currentDirectory, transactionDirectory);
          const result = await operation(transactionDirectory);
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
