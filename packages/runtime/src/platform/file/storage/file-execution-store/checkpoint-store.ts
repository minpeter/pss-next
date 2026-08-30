import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Checkpoint,
  CheckpointStore,
  CheckpointWriteResult,
} from "../../../../execution/host/types";
import { isNodeError } from "../../../../internal/guards";
import { readJsonFile, writeJsonFile } from "./json";
import type { FileRunStore } from "./run-store";
import { parseRunCheckpoint } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileCheckpointStore implements CheckpointStore {
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
    options: {
      readonly expectedLeaseId?: string | null;
      readonly expectedVersion: number;
    }
  ): Promise<CheckpointWriteResult> {
    return await this.#lock(async () => {
      const run = await this.#turns.getUnlocked(checkpoint.runId);
      if (
        options.expectedLeaseId !== undefined &&
        (run?.lease?.leaseId ?? null) !== options.expectedLeaseId
      ) {
        return { ok: false, reason: "lease-conflict" };
      }
      const current = await this.latestUnlocked(checkpoint.runId);
      const currentVersion = current?.version ?? 0;
      if (options.expectedVersion !== currentVersion) {
        return {
          currentVersion,
          ok: false,
          reason: "stale-version",
        };
      }

      await writeJsonFile(
        await this.#fileForCheckpoint(checkpoint.runId, checkpoint.version),
        checkpoint
      );
      await this.#turns.updateCheckpointVersion(
        checkpoint.runId,
        checkpoint.version
      );
      return { ok: true, version: checkpoint.version };
    });
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    return await this.#lock(async () => await this.latestUnlocked(runId));
  }

  async latestUnlocked(runId: string): Promise<Checkpoint | null> {
    const directory = join(
      await this.#directory(),
      "checkpoints",
      encodeKey(runId)
    );
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const versions = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => Number(entry.slice(0, -".json".length)))
      .filter((version) => Number.isSafeInteger(version) && version > 0)
      .sort((left, right) => right - left);

    const [latestVersion] = versions;
    if (latestVersion === undefined) {
      return null;
    }

    return await readJsonFile(
      await this.#fileForCheckpoint(runId, latestVersion),
      parseRunCheckpoint,
      "checkpoint file"
    );
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
