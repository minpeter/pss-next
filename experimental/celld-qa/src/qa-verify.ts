import { type CleanupEvent, readCleanupReceipt } from "./campaign-cleanup";
import { normalizeCliArguments } from "./campaign-cli-utils";
import { type CampaignReport, readCampaignReport } from "./campaign-report";

export async function verifyCampaignReport(
  path: string
): Promise<CampaignReport> {
  const report = await readCampaignReport(path);
  const receipt = await readCleanupReceipt(report.cleanup.receiptPath);
  const terminal = terminalCleanupEvent(receipt);
  if (!(report.passed && report.cleanup.passed && terminal.passed)) {
    throw new Error("Campaign report did not pass.");
  }
  return report;
}

export async function runVerifyCommand(
  args: readonly string[] = process.argv.slice(2)
): Promise<number> {
  try {
    const [path, ...extra] = normalizeCliArguments(args);
    if (path === undefined || extra.length > 0) {
      throw new Error("qa:verify requires exactly one report path.");
    }
    const report = await verifyCampaignReport(path);
    console.log(JSON.stringify({ command: report.command, passed: true }));
    return 0;
  } catch {
    console.error("CELLD_QA_REPORT_INVALID");
    return 1;
  }
}

function terminalCleanupEvent(
  events: readonly CleanupEvent[]
): Extract<CleanupEvent, { readonly kind: "cleanup-complete" }> {
  const terminal = events.at(-1);
  if (terminal?.kind !== "cleanup-complete") {
    throw new Error("Cleanup receipt has no terminal event.");
  }
  return terminal;
}

if (import.meta.main) {
  runVerifyCommand().then((code) => {
    process.exitCode = code;
  });
}
