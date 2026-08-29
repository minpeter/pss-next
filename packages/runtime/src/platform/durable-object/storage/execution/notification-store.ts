import type {
  NotificationClaimResult,
  NotificationInbox,
  NotificationRecord,
  NotificationWriteResult,
} from "../../../../execution";
import type { DurableObjectStorage } from "../durable-object/durable-object-storage";
import { withTransaction } from "../durable-object/sql-access";
import {
  resolveStoragePayloadMaxBytes,
  type StoragePayloadBudgetOptions,
} from "../payload-guard";
import { getNotification, putNotification } from "./notification-records";

export class DurableObjectNotificationInbox implements NotificationInbox {
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

  async claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const record = await getNotification(
        storage,
        this.#prefix,
        idempotencyKey
      );
      if (!record) {
        return { ok: false, reason: "not-found" };
      }
      if (record.status !== "pending") {
        return { ok: false, reason: "already-claimed", record };
      }
      const claimed: NotificationRecord = { ...record, status: "acked" };
      await putNotification(storage, this.#prefix, claimed, {
        maxPayloadBytes: this.#maxPayloadBytes,
      });
      return { ok: true, record: claimed };
    });
  }

  async enqueue(record: NotificationRecord): Promise<NotificationWriteResult> {
    return await withTransaction(this.#storage, async (storage) => {
      const current = await getNotification(
        storage,
        this.#prefix,
        record.idempotencyKey
      );
      if (current) {
        return {
          existingNotificationId: current.notificationId,
          ok: false,
          reason: "duplicate",
        };
      }
      await putNotification(storage, this.#prefix, record, {
        maxPayloadBytes: this.#maxPayloadBytes,
      });
      return { ok: true };
    });
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null> {
    return await getNotification(this.#storage, this.#prefix, idempotencyKey);
  }

  async releaseByIdempotencyKey(idempotencyKey: string): Promise<void> {
    await withTransaction(this.#storage, async (storage) => {
      const record = await getNotification(
        storage,
        this.#prefix,
        idempotencyKey
      );
      if (record?.status === "acked") {
        await putNotification(
          storage,
          this.#prefix,
          {
            ...record,
            status: "pending",
          },
          { maxPayloadBytes: this.#maxPayloadBytes }
        );
      }
    });
  }
}
