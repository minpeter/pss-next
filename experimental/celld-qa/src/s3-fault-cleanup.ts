import type { CleanupRemaining } from "./campaign-cleanup";
import { measureCleanupRemaining } from "./campaign-cleanup-measure";
import { countPrefixObjects } from "./celld-bucket";
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
