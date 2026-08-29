import { randomUUID } from "node:crypto";
import {
  ackThreadInputClaim,
  admitThreadInput,
  claimNextThreadInput,
  promoteThreadInputClaim,
  releaseThreadInputClaim,
} from "../../../../execution/host/thread-input-inbox";
import { recoverThreadInputClaims } from "../../../../execution/host/thread-input-recovery";
import type {
  AdmitReceipt,
  AdmitThreadInput,
  ClaimedThreadInput,
  ClaimThreadInputOptions,
  RecoverThreadInputClaimsOptions,
  RecoverThreadInputClaimsResult,
  ThreadInputBoundary,
  ThreadInputInbox,
  ThreadInputRecord,
} from "../../../../execution/host/types";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import { withTransaction } from "../durable-object/sql-access";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { listThreadInputRecords, putThreadInputRecords } from "./input-records";

export class DurableObjectThreadInputInbox implements ThreadInputInbox {
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

  async admit(input: AdmitThreadInput): Promise<AdmitReceipt> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await listThreadInputRecords(
        storage,
        this.#prefix,
        input.threadKey
      );
      const transition = admitThreadInput(current, input);
      if (!transition.receipt.duplicate) {
        await putThreadInputRecords(storage, this.#prefix, transition.records, {
          maxPayloadBytes: this.#maxPayloadBytes,
        });
      }
      return structuredClone(transition.receipt);
    });
  }

  async claimNext(
    threadKey: string,
    boundary: ThreadInputBoundary,
    options: ClaimThreadInputOptions = {}
  ): Promise<ClaimedThreadInput | null> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await listThreadInputRecords(
        storage,
        this.#prefix,
        threadKey
      );
      const transition = claimNextThreadInput(
        current,
        threadKey,
        boundary,
        randomUUID(),
        options
      );
      if (transition.record) {
        await putThreadInputRecords(storage, this.#prefix, transition.records, {
          maxPayloadBytes: this.#maxPayloadBytes,
        });
      }
      return transition.record ? structuredClone(transition.record) : null;
    });
  }

  async releaseClaim(
    claim: ClaimedThreadInput
  ): Promise<ThreadInputRecord | null> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await listThreadInputRecords(
        storage,
        this.#prefix,
        claim.threadKey
      );
      const transition = releaseThreadInputClaim(current, claim);
      if (transition.record) {
        await putThreadInputRecords(storage, this.#prefix, transition.records, {
          maxPayloadBytes: this.#maxPayloadBytes,
        });
      }
      return transition.record ? structuredClone(transition.record) : null;
    });
  }

  async markPromoted(
    claim: ClaimedThreadInput
  ): Promise<ThreadInputRecord | null> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await listThreadInputRecords(
        storage,
        this.#prefix,
        claim.threadKey
      );
      const transition = promoteThreadInputClaim(current, claim);
      if (transition.record) {
        await putThreadInputRecords(storage, this.#prefix, transition.records, {
          maxPayloadBytes: this.#maxPayloadBytes,
        });
      }
      return transition.record ? structuredClone(transition.record) : null;
    });
  }

  async ack(record: ThreadInputRecord): Promise<ThreadInputRecord | null> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await listThreadInputRecords(
        storage,
        this.#prefix,
        record.threadKey
      );
      const transition = ackThreadInputClaim(current, record);
      if (transition.record) {
        await putThreadInputRecords(storage, this.#prefix, transition.records, {
          maxPayloadBytes: this.#maxPayloadBytes,
        });
      }
      return transition.record ? structuredClone(transition.record) : null;
    });
  }

  async recoverClaims(
    threadKey: string,
    options: RecoverThreadInputClaimsOptions = {}
  ): Promise<RecoverThreadInputClaimsResult> {
    return await withTransaction(this.#storage, async (storage) => {
      options.signal?.throwIfAborted();
      const current = await listThreadInputRecords(
        storage,
        this.#prefix,
        threadKey
      );
      options.signal?.throwIfAborted();
      const transition = recoverThreadInputClaims(current, threadKey);
      if (transition.acked.length > 0 || transition.released.length > 0) {
        await putThreadInputRecords(storage, this.#prefix, transition.records, {
          maxPayloadBytes: this.#maxPayloadBytes,
        });
      }
      return {
        acked: transition.acked.map((record) => structuredClone(record)),
        released: transition.released.map((record) => structuredClone(record)),
      };
    });
  }
}
