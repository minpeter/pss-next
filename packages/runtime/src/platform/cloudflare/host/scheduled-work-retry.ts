import type { TurnRecord, TurnStatus } from "../../../execution";
import type { CloudflareDurableObjectStorage } from "../storage/durable-object/durable-object-storage";
import { createCloudflareStorageHost } from "./durable-object-host";

export async function shouldRetryNotClaimableScheduledRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const run = await createCloudflareStorageHost({
    prefix,
    storage,
  }).store.turns.get(runId);
  return (
    run?.kind === "notification" &&
    run.dedupeKey !== undefined &&
    run.dedupeKey.length > 0 &&
    isRetryableRunStatus(run.status) &&
    !hasActiveLease(run)
  );
}

export async function prepareScheduledNotificationRetry(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  const host = createCloudflareStorageHost({ prefix, storage });
  let prepared = false;
  await host.store.transaction(async (tx) => {
    const run = await tx.turns.get(runId);
    if (run?.kind !== "notification" || !run.dedupeKey) {
      return;
    }

    await tx.turns.update(retryableNotificationRun(run));
    await tx.notifications.releaseByIdempotencyKey(run.dedupeKey);
    prepared = true;
  });
  return prepared;
}

function isRetryableRunStatus(status: TurnStatus | undefined): boolean {
  return (
    status === "leased" ||
    status === "queued" ||
    status === "running" ||
    status === "suspended"
  );
}

function hasActiveLease(run: TurnRecord): boolean {
  return run.lease !== undefined && run.lease.leaseUntilMs > Date.now();
}

function retryableNotificationRun(run: TurnRecord): TurnRecord {
  const { lease: _lease, ...runWithoutLease } = run;
  return { ...runWithoutLease, status: "queued" };
}
