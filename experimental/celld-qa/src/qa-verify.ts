import {
  readCleanupReceipt,
  requireCleanupReceiptBinding,
  terminalCleanupEvent,
} from "./campaign-cleanup";
import { normalizeCliArguments } from "./campaign-cli-utils";
import { type CampaignReport, readCampaignReport } from "./campaign-report";

export async function verifyCampaignReport(
  path: string
): Promise<CampaignReport> {
  const report = await readCampaignReport(path);
  const cleanupPassed = await verifyBoundCleanup(
    report.cleanup.receiptPath,
    report.runId,
    report.command
  );
  if (report.cleanup.passed !== cleanupPassed) {
    throw new Error("Cleanup evidence is internally inconsistent.");
  }
  const scenarioViolations = report.scenarios.flatMap((scenario) =>
    scenario.violations.map((violation) => `${scenario.name}: ${violation}`)
  );
  const reportPassed =
    cleanupPassed &&
    scenarioViolations.length === 0 &&
    report.scenarios.every((scenario) => scenario.violations.length === 0);
  if (
    report.passed !== reportPassed ||
    JSON.stringify(report.violations) !== JSON.stringify(scenarioViolations)
  ) {
    throw new Error("Campaign report verdict is internally inconsistent.");
  }
  if (report.command === "profiles") {
    await verifyProfileReceipts(report);
  }
  return report;
}

async function verifyProfileReceipts(report: CampaignReport): Promise<void> {
  const cleanupPaths = new Set<string>();
  const runIds = new Set<string>();
  for (const scenario of report.scenarios) {
    const cleanupPath = scenario.observables.cleanupPath;
    const runId = scenario.observables.runId;
    if (typeof cleanupPath !== "string" || typeof runId !== "string") {
      throw new Error("Profile cleanup evidence is invalid.");
    }
    if (cleanupPaths.has(cleanupPath) || runIds.has(runId)) {
      throw new Error("Profile cleanup evidence is shared across scenarios.");
    }
    cleanupPaths.add(cleanupPath);
    runIds.add(runId);
    const cleanupPassed = await verifyBoundCleanup(
      cleanupPath,
      runId,
      "profiles"
    );
    if (scenario.observables.cleanupPassed !== cleanupPassed) {
      throw new Error("Profile cleanup evidence is internally inconsistent.");
    }
  }
}

async function verifyBoundCleanup(
  path: string,
  runId: string,
  command: CampaignReport["command"]
): Promise<boolean> {
  const receipt = await readCleanupReceipt(path);
  requireCleanupReceiptBinding(receipt, runId, command);
  const terminal = terminalCleanupEvent(receipt);
  return Object.values(terminal.remaining).every((value) => value === 0);
}

export async function runVerifyCommand(
  args: readonly string[] = process.argv.slice(2)
): Promise<number> {
  try {
    const [path, ...extra] = normalizeCliArguments(args);
    if (path === "--help" || path === "-h") {
      console.log("Usage: qa:verify <report-path>");
      return 0;
    }
    if (path === undefined || extra.length > 0) {
      throw new Error("qa:verify requires exactly one report path.");
    }
    const report = await verifyCampaignReport(path);
    if (!report.passed) {
      throw new Error("Campaign report records a failed verdict.");
    }
    console.log(JSON.stringify({ command: report.command, passed: true }));
    return 0;
  } catch {
    console.error("CELLD_QA_REPORT_INVALID");
    return 1;
  }
}

if (import.meta.main) {
  runVerifyCommand().then((code) => {
    process.exitCode = code;
  });
}
