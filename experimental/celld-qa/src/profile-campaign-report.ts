import { randomUUID } from "node:crypto";
import {
  type CleanupRemaining,
  cleanupCompleteEvent,
  cleanupReceiptBinding,
  readCleanupReceipt,
  terminalCleanupEvent,
  writeCleanupReceipt,
} from "./campaign-cleanup";
import {
  buildCampaignReport,
  type CampaignReport,
  type JsonValue,
  writeCampaignReport,
} from "./campaign-report";
import type { ProfileName } from "./profile-types";

export interface ProfileCampaignScenario {
  readonly name: ProfileName;
  readonly observables: Readonly<Record<string, JsonValue>>;
  readonly violations: readonly string[];
}

export async function writeProfileCampaignReport(
  reportPath: string,
  scenarios: readonly ProfileCampaignScenario[]
): Promise<CampaignReport> {
  const cleanupPath = `${reportPath}.cleanup.jsonl`;
  const runId = randomUUID();
  const cleanup = cleanupCompleteEvent(
    await aggregateProfileCleanup(scenarios)
  );
  await writeCleanupReceipt(
    cleanupPath,
    [cleanup],
    cleanupReceiptBinding(runId, "profiles")
  );
  const report = buildCampaignReport({
    cleanup: { passed: cleanup.passed, receiptPath: cleanupPath },
    command: "profiles",
    runId,
    scenarios,
  });
  await writeCampaignReport(reportPath, report);
  return report;
}

async function aggregateProfileCleanup(
  scenarios: readonly ProfileCampaignScenario[]
): Promise<CleanupRemaining> {
  const remaining: CleanupRemaining[] = [];
  for (const scenario of scenarios) {
    const cleanupPath = scenario.observables.cleanupPath;
    if (typeof cleanupPath !== "string") {
      throw new Error(`${scenario.name} has no cleanup receipt path.`);
    }
    remaining.push(
      terminalCleanupEvent(await readCleanupReceipt(cleanupPath)).remaining
    );
  }
  return {
    containers: sumRemaining(remaining, "containers"),
    ports: sumRemaining(remaining, "ports"),
    prefixObjects: sumRemaining(remaining, "prefixObjects"),
    processes: sumRemaining(remaining, "processes"),
    proxyFaults: sumRemaining(remaining, "proxyFaults"),
    watchPaths: sumRemaining(remaining, "watchPaths"),
  };
}

function sumRemaining(
  values: readonly CleanupRemaining[],
  key: keyof CleanupRemaining
): number {
  return values.reduce((sum, value) => sum + value[key], 0);
}
