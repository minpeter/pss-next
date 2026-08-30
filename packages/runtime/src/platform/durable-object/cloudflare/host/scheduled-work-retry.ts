import {
  type TurnRecord,
  type TurnStatus,
  type TurnStore,
  transitionTurn,
} from "../../../../execution";
import { createDurableObjectStorageHost as createCloudflareStorageHost } from "../../host/storage-host";
import {
  type DurableObjectStorage as CloudflareDurableObjectStorage,
  withSqlStorage,
} from "../../storage/durable-object/durable-object-storage";
import { withTransaction } from "../../storage/durable-object/sql-access";

interface ScheduledNotificationRetry {
  readonly allowNonNotification: boolean;
  readonly leaseId: string;
  readonly prefix: string;
  readonly runId: string;
  readonly schedule: (storage: CloudflareDurableObjectStorage) => Promise<void>;
  readonly storage: CloudflareDurableObjectStorage;
}

export async function prepareScheduledNotificationRetry({
  allowNonNotification,
  leaseId,
  prefix,
  runId,
  schedule,
  storage,
}: ScheduledNotificationRetry): Promise<boolean> {
  return await withTransaction(storage, async (txStorage) => {
    const transactionStorage = withSqlStorage(
      txStorage,
      txStorage.sql ?? storage.sql
    );
    const tx = createCloudflareStorageHost({
      prefix,
      storage: transactionStorage,
    }).store;
    const run = await captureRetryOwnership({
      allowNonNotification,
      leaseId,
      runId,
      turns: tx.turns,
    });
    if (!run) {
      return false;
    }

    const transition = await transitionTurn(tx.turns, {
      expected: {
        leaseId,
        status: run.status,
      },
      runId,
      update: { lease: null, status: "queued" },
    });
    if (!transition.ok) {
      return false;
    }
    const dedupeKey = run.kind === "notification" ? run.dedupeKey : undefined;
    try {
      await schedule(transactionStorage);
    } catch (error) {
      const rollback = await transitionTurn(tx.turns, {
        expected: { leaseId: null, status: "queued" },
        runId,
        update: {
          lease: run.lease ?? null,
          status: run.status,
        },
      });
      if (!rollback.ok) {
        throw new Error(
          `Retry schedule rollback failed for ${runId}: ${rollback.reason}.`,
          { cause: error }
        );
      }
      throw error;
    }
    if (dedupeKey) {
      await tx.notifications.releaseByIdempotencyKey(dedupeKey);
    }
    return true;
  });
}

async function captureRetryOwnership({
  allowNonNotification,
  leaseId,
  runId,
  turns,
}: {
  readonly allowNonNotification: boolean;
  readonly leaseId: string;
  readonly runId: string;
  readonly turns: TurnStore;
}): Promise<TurnRecord | null> {
  const run = await turns.get(runId);
  if (isOwnedRetryableRun(run, leaseId, allowNonNotification)) {
    return run;
  }
  if (!isUnleasedRetryableRun(run, allowNonNotification)) {
    return null;
  }
  const claim = await turns.claim(runId, {
    attempt: 1,
    leaseId,
    leaseMs: 300_000,
    nowMs: Date.now(),
  });
  return claim.ok ? claim.record : null;
}

function isOwnedRetryableRun(
  run: TurnRecord | null,
  leaseId: string,
  allowNonNotification: boolean
): run is TurnRecord {
  if (
    !(run && isRetryableRunStatus(run.status)) ||
    (run.lease?.leaseId ?? null) !== leaseId
  ) {
    return false;
  }
  return run.kind === "notification"
    ? run.dedupeKey !== undefined
    : allowNonNotification;
}

function isUnleasedRetryableRun(
  run: TurnRecord | null,
  allowNonNotification: boolean
): run is TurnRecord {
  if (!(run && isRetryableRunStatus(run.status)) || run.lease !== undefined) {
    return false;
  }
  return run.kind === "notification"
    ? run.dedupeKey !== undefined
    : allowNonNotification;
}

function isRetryableRunStatus(status: TurnStatus): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}
