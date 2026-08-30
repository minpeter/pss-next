import { join } from "node:path";
import {
  decideCheckpointVersionWrite,
  decideLeaseFencedCheckpointWrite,
} from "../../../../execution/host/checkpoint-write-decision";
import type {
  Checkpoint,
  CheckpointStore,
  CheckpointWriteResult,
  LeaseFencedCheckpointStore,
  LeaseFencedCheckpointWriteOptions,
  LeaseFencedCheckpointWriteResult,
  TurnRecord,
} from "../../../../execution/host/types";
import { readJsonFile, writeJsonFile } from "./json";
import type { FileRunStore } from "./run-store";
import { parseRunCheckpoint } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileCheckpointCorruptionError extends Error {
  readonly checkpointVersion: number;
  readonly runId: string;

  constructor(runId: string, checkpointVersion: number) {
    super(
      `File checkpoint authority for run ${runId} references missing version ${checkpointVersion}.`
    );
    this.name = "FileCheckpointCorruptionError";
    this.checkpointVersion = checkpointVersion;
    this.runId = runId;
  }
}

export class FileCheckpointStore
  implements CheckpointStore, LeaseFencedCheckpointStore
{
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly #turns: FileRunStore;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>,
    turns: FileRunStore
  ) {
    this.#directory = directory;
    this.#lock = lock;
    this.#turns = turns;
  }

  async append(
    checkpoint: Checkpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult> {
    return await this.#lock(async () => {
      const run = await this.#turns.getUnlocked(checkpoint.runId);
      const decision = decideCheckpointVersionWrite(
        run?.checkpointVersion ?? 0,
        options.expectedVersion
      );
      if (!decision.ok) {
        return decision;
      }
      await this.#persist(checkpoint, run);
      return { ok: true, version: checkpoint.version };
    });
  }

  async appendFenced(
    checkpoint: Checkpoint,
    options: LeaseFencedCheckpointWriteOptions
  ): Promise<LeaseFencedCheckpointWriteResult> {
    return await this.#lock(async () => {
      const decision = decideLeaseFencedCheckpointWrite(
        checkpoint.runId,
        await this.#turns.getUnlocked(checkpoint.runId),
        checkpoint,
        options
      );
      if (!decision.ok) {
        return decision;
      }
      await this.#persist(checkpoint, decision.run);
      return { ok: true, version: checkpoint.version };
    });
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    return await this.#lock(async () => await this.latestUnlocked(runId));
  }

  async latestUnlocked(runId: string): Promise<Checkpoint | null> {
    const run = await this.#turns.getUnlocked(runId);
    if (!(run && run.runId === runId && run.checkpointVersion > 0)) {
      return null;
    }
    const checkpointVersion = run.checkpointVersion;
    const checkpoint = await readJsonFile(
      await this.#fileForCheckpoint(runId, checkpointVersion),
      parseRunCheckpoint,
      "checkpoint file"
    );
    if (!checkpoint) {
      throw new FileCheckpointCorruptionError(runId, checkpointVersion);
    }
    return checkpoint;
  }

  async #persist(
    checkpoint: Checkpoint,
    run: TurnRecord | null | undefined
  ): Promise<void> {
    await writeJsonFile(
      await this.#fileForCheckpoint(checkpoint.runId, checkpoint.version),
      checkpoint
    );
    if (run) {
      await this.#turns.updateCheckpointVersion(
        checkpoint.runId,
        checkpoint.version
      );
    }
  }

  async #fileForCheckpoint(runId: string, version: number): Promise<string> {
    return join(
      await this.#directory(),
      "checkpoints",
      encodeKey(runId),
      `${version}.json`
    );
  }
}
