import { type TurnStatus, transitionTurn } from "../../../../execution";
import { createDurableObjectStorageHost as createCloudflareStorageHost } from "../../host/storage-host";
import {
  type DurableObjectStorage as CloudflareDurableObjectStorage,
  withSqlStorage,
} from "../../storage/durable-object/durable-object-storage";
import { withTransaction } from "../../storage/durable-object/sql-access";

interface ScheduledNotificationRetry {
  readonly allowActiveLease: boolean;
  readonly allowNonNotification: boolean;
  readonly leaseId: string | null;
  readonly prefix: string;
  readonly runId: string;
  readonly schedule: (storage: CloudflareDurableObjectStorage) => Promise<void>;
  readonly storage: CloudflareDurableObjectStorage;
}

export async function prepareScheduledNotificationRetry({
  allowActiveLease,
  allowNonNotification,
  leaseId,
  prefix,
  runId,
  schedule,
  storage,
}: ScheduledNotificationRetry): Promise<boolean> {
  let prepared = false;
  await withTransaction(storage, async (txStorage) => {
    const transactionStorage = withSqlStorage(
      txStorage,
      txStorage.sql ?? storage.sql
    );
    const tx = createCloudflareStorageHost({
      prefix,
      storage: transactionStorage,
    }).store;
    const run = await tx.turns.get(runId);
    if (run?.kind !== "notification") {
      if (allowNonNotification) {
        await schedule(transactionStorage);
        prepared = true;
      }
      return;
    }
    const currentLeaseId = run.lease?.leaseId ?? null;
    const recoversExpiredLease =
      !allowActiveLease &&
      leaseId === null &&
      run.lease !== undefined &&
      run.lease.leaseUntilMs <= Date.now();
    if (
      !(run.dedupeKey && isRetryableRunStatus(run.status)) ||
      (!allowActiveLease &&
        run.lease !== undefined &&
        run.lease.leaseUntilMs > Date.now()) ||
      (currentLeaseId !== leaseId && !recoversExpiredLease)
    ) {
      return;
    }

    const transition = await transitionTurn(tx.turns, {
      expected: {
        leaseId: recoversExpiredLease ? currentLeaseId : leaseId,
        status: run.status,
      },
      runId,
      update: { lease: null, status: "queued" },
    });
    if (!transition.ok) {
      return;
    }
    try {
      await schedule(transactionStorage);
    } catch (error) {
      await tx.turns.update(run);
      throw error;
    }
    await tx.notifications.releaseByIdempotencyKey(run.dedupeKey);
    prepared = true;
  });
  return prepared;
}

function isRetryableRunStatus(status: TurnStatus): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}
