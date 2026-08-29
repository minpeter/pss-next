import type {
  ClaimTurnOptions,
  ClaimTurnResult,
  CreateTurnResult,
  TurnRecord,
  TurnStatus,
  TurnStore,
} from "../../../../execution";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import { withTransaction } from "../durable-object/sql-access";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import {
  getRun,
  getRunByDedupeKey,
  insertRun,
  listRunsByParentRunId,
  putRun,
} from "./run-records";

const claimableStatuses = new Set<TurnStatus>([
  "leased",
  "queued",
  "running",
  "suspended",
]);

export class DurableObjectRunStore implements TurnStore {
  readonly #maxPayloadBytes: number;
  readonly #prefix: string;
  readonly #storage: DurableObjectStorage;

  constructor(
    storage: DurableObjectStorage,
    prefix: string,
    options: StoragePayloadBudgetOptions = {}
  ) {
    this.#maxPayloadBytes = resolveStoragePayloadMaxBytes(options);
    this.#prefix = prefix;
    this.#storage = storage;
  }

  async claim(
    runId: string,
    options: ClaimTurnOptions
  ): Promise<ClaimTurnResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const run = await getRun(storage, this.#prefix, runId);
      if (!run) {
        return { ok: false, reason: "not-found" };
      }
      if (!claimableStatuses.has(run.status)) {
        return { ok: false, reason: "not-claimable" };
      }
      if (run.lease && run.lease.leaseUntilMs > options.nowMs) {
        return { ok: false, reason: "leased" };
      }

      const lease = {
        attempt: options.attempt,
        leaseId: options.leaseId,
        leaseUntilMs: options.nowMs + options.leaseMs,
      };
      const claimed: TurnRecord = { ...run, lease, status: "leased" };
      await putRun(storage, this.#prefix, claimed, {
        maxPayloadBytes: this.#maxPayloadBytes,
      });
      return { lease, ok: true, record: structuredClone(claimed) };
    });
  }

  async create(record: TurnRecord): Promise<CreateTurnResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const existing =
        (await getRun(storage, this.#prefix, record.runId)) ??
        (record.dedupeKey
          ? await getRunByDedupeKey(storage, this.#prefix, record.dedupeKey)
          : null);
      if (existing) {
        return {
          ok: false,
          reason: "duplicate",
          record: structuredClone(existing),
        };
      }

      await insertRun(storage, this.#prefix, record, {
        maxPayloadBytes: this.#maxPayloadBytes,
      });
      return { ok: true, record: structuredClone(record) };
    });
  }

  async get(runId: string): Promise<TurnRecord | null> {
    return await getRun(this.#storage, this.#prefix, runId);
  }

  async getByDedupeKey(dedupeKey: string): Promise<TurnRecord | null> {
    return await getRunByDedupeKey(this.#storage, this.#prefix, dedupeKey);
  }

  async listByParentRunId(parentRunId: string): Promise<readonly TurnRecord[]> {
    return await listRunsByParentRunId(
      this.#storage,
      this.#prefix,
      parentRunId
    );
  }

  async update(record: TurnRecord): Promise<TurnRecord> {
    return await withTransaction(this.#storage, async (storage) => {
      await putRun(storage, this.#prefix, record, {
        maxPayloadBytes: this.#maxPayloadBytes,
      });
      return structuredClone(record);
    });
  }
}
