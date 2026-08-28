import type { CleanupRemaining } from "./campaign-cleanup";
import { measureCleanupRemaining } from "./campaign-cleanup-measure";
import { countPrefixObjects } from "./celld-bucket";
import { type CelldChild, stopCelld } from "./celld-process";
import type { FaultProxyControlClient } from "./fault-proxy-control-client";
import type { ToxiproxyClient } from "./toxiproxy-client";

export interface S3CleanupOptions {
  readonly control: FaultProxyControlClient;
  readonly endpoint: string;
  readonly ownedPids: readonly number[];
  readonly port: number;
  readonly prefix: string;
  readonly proxyName: string;
  readonly toxiproxy: ToxiproxyClient;
  readonly watch: string;
}

export function measureS3Cleanup({
  control,
  endpoint,
  ownedPids,
  port,
  prefix,
  proxyName,
  toxiproxy,
  watch,
}: S3CleanupOptions): Promise<CleanupRemaining> {
  return measureCleanupRemaining({
    containerNames: [],
    pids: ownedPids,
    ports: [port],
    prefixObjectChecks: [() => countPrefixObjects(prefix, { endpoint })],
    proxyFaultChecks: [
      async () => {
        const [generation, toxicCount] = await Promise.all([
          control.generation(),
          toxiproxy.countToxics(proxyName),
        ]);
        return toxicCount + (generation.rule.kind === "pass" ? 0 : 1);
      },
    ],
    watchPaths: [watch],
  });
}

export async function settleS3Cleanup(
  operations: readonly (() => Promise<void>)[],
  measure: () => Promise<CleanupRemaining>
): Promise<CleanupRemaining> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  const measurement = await measure().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ error, ok: false }) as const
  );
  if (!measurement.ok) {
    errors.push(measurement.error);
    throw new AggregateError(errors, "S3 cleanup failed");
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "S3 cleanup failed");
  }
  return measurement.value;
}

export async function stopOwnedCelld(
  child: CelldChild | undefined
): Promise<void> {
  if (child !== undefined) {
    await stopCelld(child);
  }
}

export async function resetFaultProxy(
  control: FaultProxyControlClient
): Promise<void> {
  await control.install({ kind: "pass" });
}
