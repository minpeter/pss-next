import { rm } from "node:fs/promises";
import {
  cleanupCompleteEvent,
  cleanupReceiptBinding,
  writeCleanupReceipt,
} from "./campaign-cleanup";
import { measureCleanupRemaining } from "./campaign-cleanup-measure";
import { cleanupPrefix, countPrefixObjects } from "./celld-bucket";
import type { CelldChild } from "./celld-process";
import { stopCelld } from "./celld-process";

export interface ProfileCleanupOptions {
  readonly child: CelldChild | undefined;
  readonly cleanupPath: string;
  readonly ownedPids: readonly number[];
  readonly port: number;
  readonly prefix: string;
  readonly runId: string;
  readonly watch: string;
}

export async function cleanupLiveProfile({
  child,
  cleanupPath,
  ownedPids,
  port,
  prefix,
  runId,
  watch,
}: ProfileCleanupOptions): Promise<boolean> {
  if (child !== undefined) {
    await stopCelld(child);
  }
  await cleanupPrefix(prefix);
  await rm(watch, { force: true, recursive: true });
  const remaining = await measureCleanupRemaining({
    containerNames: [],
    pids: ownedPids,
    ports: [port],
    prefixObjectChecks: [() => countPrefixObjects(prefix)],
    proxyFaultChecks: [],
    watchPaths: [watch],
  });
  const cleanup = cleanupCompleteEvent(remaining);
  await writeCleanupReceipt(
    cleanupPath,
    [cleanup],
    cleanupReceiptBinding(runId, "profiles")
  );
  return cleanup.passed;
}

export function recordOwnedPid(child: CelldChild, ownedPids: number[]): void {
  if (child.pid !== undefined) {
    ownedPids.push(child.pid);
  }
}
