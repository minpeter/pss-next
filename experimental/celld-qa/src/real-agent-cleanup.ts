import type { CleanupRemaining } from "./campaign-cleanup";
import { measureCleanupRemaining } from "./campaign-cleanup-measure";
import { countPrefixObjects } from "./celld-bucket";
import type { CelldChild } from "./celld-process";
import type { RealAgentCleanupScope } from "./qa-real-agent-types";

export function measureRealAgentCleanup({
  children,
  port,
  prefix,
  watch,
}: RealAgentCleanupScope<CelldChild>): Promise<CleanupRemaining> {
  return measureCleanupRemaining({
    containerNames: [],
    pids: children.flatMap((child) =>
      child.pid === undefined ? [] : [child.pid]
    ),
    ports: [port],
    prefixObjectChecks: [() => countPrefixObjects(prefix)],
    proxyFaultChecks: [],
    watchPaths: [watch],
  });
}
