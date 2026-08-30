import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applyTurnTransitionUpdate,
  decideTurnClaim,
  decideTurnTransition,
} from "../../../../execution/host/turn-status";
import type {
  ClaimTurnOptions,
  ClaimTurnResult,
  CreateTurnResult,
  TurnLease,
  TurnRecord,
  TurnStore,
  TurnTransitionExpected,
  TurnTransitionResult,
  TurnTransitionUpdate,
} from "../../../../execution/host/types";
import { isNodeError } from "../../../../internal/guards";
import { readJsonFile, writeJsonFile } from "./json";
import { parseRunRecord } from "./schemas";
import type { DataDirectoryResolver } from "./types";
import { encodeKey } from "./utils";

export class FileRunStore implements TurnStore {
  readonly #directory: DataDirectoryResolver;
  readonly #lock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    directory: DataDirectoryResolver,
    lock: <T>(fn: () => Promise<T>) => Promise<T>
  ) {
    this.#directory = directory;
    this.#lock = lock;
  }

  async claim(
    runId: string,
    options: ClaimTurnOptions
  ): Promise<ClaimTurnResult> {
    return await this.#lock(async () => {
      const record = await this.#getUnlocked(runId);
      if (!record) {
        return { ok: false, reason: "not-found" };
      }

      const decision = decideTurnClaim(runId, record, options.nowMs);
      if (!decision.ok) {
        return decision;
      }

      const lease: TurnLease = {
        attempt: options.attempt,
        leaseId: options.leaseId,
        leaseUntilMs: options.nowMs + options.leaseMs,
      };
      const claimed: TurnRecord = { ...record, lease, status: "leased" };
      await this.#writeUnlocked(claimed);
      return { lease, ok: true, record: claimed };
    });
  }

  async create(record: TurnRecord): Promise<CreateTurnResult> {
    return await this.#lock(async () => {
      const existingById = await this.#getUnlocked(record.runId);
      if (existingById) {
        return { ok: false, reason: "duplicate", record: existingById };
      }

      if (record.dedupeKey) {
        const existingByDedupeKey = await this.#getByDedupeKeyUnlocked(
          record.dedupeKey
        );
        if (existingByDedupeKey) {
          return {
            ok: false,
            reason: "duplicate",
            record: existingByDedupeKey,
          };
        }
      }

      await this.#writeUnlocked(record);
      return { ok: true, record };
    });
  }

  async get(runId: string): Promise<TurnRecord | null> {
    return await this.#lock(async () => await this.#getUnlocked(runId));
  }

  async getByDedupeKey(dedupeKey: string): Promise<TurnRecord | null> {
    return await this.#lock(
      async () => await this.#getByDedupeKeyUnlocked(dedupeKey)
    );
  }

  async listByParentRunId(parentRunId: string): Promise<readonly TurnRecord[]> {
    return await this.#lock(async () => {
      const records = await this.#listUnlocked();
      return records.filter((record) => record.parentRunId === parentRunId);
    });
  }

  async transition(
    runId: string,
    expected: TurnTransitionExpected,
    update: TurnTransitionUpdate
  ): Promise<TurnTransitionResult> {
    return await this.#lock(async () => {
      const current = await this.#getUnlocked(runId);
      if (!current) {
        return { ok: false, reason: "not-found" };
      }
      const conflict = decideTurnTransition(runId, current, expected);
      if (conflict) {
        return conflict;
      }
      const record = applyTurnTransitionUpdate(current, update);
      await this.#writeUnlocked(record);
      return { ok: true, record: structuredClone(record) };
    });
  }

  async update(record: TurnRecord): Promise<TurnRecord> {
    return await this.#lock(async () => {
      await this.#writeUnlocked(record);
      return record;
    });
  }

  async updateCheckpointVersion(
    runId: string,
    checkpointVersion: number
  ): Promise<void> {
    const record = await this.#getUnlocked(runId);
    if (!record) {
      return;
    }
    await this.#writeUnlocked({ ...record, checkpointVersion });
  }

  getUnlocked(runId: string): Promise<TurnRecord | null> {
    return this.#getUnlocked(runId);
  }

  async #getByDedupeKeyUnlocked(dedupeKey: string): Promise<TurnRecord | null> {
    const records = await this.#listUnlocked();
    return records.find((record) => record.dedupeKey === dedupeKey) ?? null;
  }

  async #getUnlocked(runId: string): Promise<TurnRecord | null> {
    return await readJsonFile(
      await this.#fileForRun(runId),
      parseRunRecord,
      "run file"
    );
  }

  async #listUnlocked(): Promise<readonly TurnRecord[]> {
    const directory = join(await this.#directory(), "runs");
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records: TurnRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const record = await readJsonFile(
        join(directory, entry),
        parseRunRecord,
        "run file"
      );
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  async #writeUnlocked(record: TurnRecord): Promise<void> {
    await writeJsonFile(await this.#fileForRun(record.runId), record);
  }

  async #fileForRun(runId: string): Promise<string> {
    return join(await this.#directory(), "runs", `${encodeKey(runId)}.json`);
  }
}
