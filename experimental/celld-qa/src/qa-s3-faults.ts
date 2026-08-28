import {
  cleanupCompleteEvent,
  cleanupReceiptBinding,
  writeCleanupReceipt,
} from "./campaign-cleanup";
import {
  normalizeCliArguments,
  requiredStringOption,
} from "./campaign-cli-utils";
import { buildCampaignReport, writeCampaignReport } from "./campaign-report";
import {
  BoundaryInputError,
  FAULT_KINDS,
  requireLoopbackUrl,
  type S3FaultReport,
} from "./fault-proxy-types";
import {
  type LiveCampaignOptions,
  runLiveS3FaultCampaign,
} from "./s3-fault-runner";

interface CliDependencies {
  readonly run: (options: LiveCampaignOptions) => Promise<S3FaultReport>;
  readonly write: (text: string) => void;
}

const DEFAULTS = Object.freeze({
  controlUrl: "http://127.0.0.1:14568",
  port: 16_436,
  proxyUrl: "http://127.0.0.1:14567",
  s3Url: "http://127.0.0.1:14566",
  toxiproxyUrl: "http://127.0.0.1:18474",
});

export function parseS3FaultCli(argv: readonly string[]): LiveCampaignOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !isKnownFlag(key)) {
      throw new BoundaryInputError(
        "Usage: qa-s3-faults --proxy-url <url> --control-url <url> --toxiproxy-url <url> --port <port> --scenarios <list>"
      );
    }
    values.set(key, value);
  }
  const options = {
    controlUrl: values.get("--control-url") ?? DEFAULTS.controlUrl,
    port: Number(values.get("--port") ?? DEFAULTS.port),
    proxyUrl: values.get("--proxy-url") ?? DEFAULTS.proxyUrl,
    s3Url: values.get("--s3-url") ?? DEFAULTS.s3Url,
    toxiproxyUrl: values.get("--toxiproxy-url") ?? DEFAULTS.toxiproxyUrl,
  };
  const scenarios = (values.get("--scenarios") ?? FAULT_KINDS.join(",")).split(
    ","
  );
  if (
    scenarios.length !== FAULT_KINDS.length ||
    scenarios.some((scenario, index) => scenario !== FAULT_KINDS[index])
  ) {
    throw new BoundaryInputError(
      "qa:s3-faults requires all eight frozen scenarios in order"
    );
  }
  if (!Number.isInteger(options.port) || options.port < 1) {
    throw new BoundaryInputError("--port must be a positive integer");
  }
  requireLoopbackUrl(options.controlUrl, "fault proxy control endpoint");
  requireLoopbackUrl(options.proxyUrl, "fault proxy data endpoint");
  requireLoopbackUrl(options.s3Url, "LocalStack endpoint");
  requireLoopbackUrl(options.toxiproxyUrl, "Toxiproxy control endpoint");
  return Object.freeze(options);
}

export async function runS3FaultCli(
  argv: readonly string[],
  dependencies: CliDependencies = {
    run: async (options) => (await runLiveS3FaultCampaign(options)).report,
    write: (text) => process.stdout.write(text),
  }
): Promise<0 | 1> {
  const report = await dependencies.run(parseS3FaultCli(argv));
  dependencies.write(`${JSON.stringify(report)}\n`);
  return report.ok ? 0 : 1;
}

export async function runCampaignCommand(
  argv: readonly string[]
): Promise<void> {
  const args = normalizeCliArguments(argv);
  const reportPath = requiredStringOption(args, "--report");
  const result = await runLiveS3FaultCampaign(
    parseS3FaultCli(removeOption(args, "--report"))
  );
  const cleanupPath = `${reportPath}.cleanup.jsonl`;
  const cleanup = cleanupCompleteEvent(result.cleanup);
  await writeCleanupReceipt(
    cleanupPath,
    [cleanup],
    cleanupReceiptBinding(result.runId, "s3-faults")
  );
  const report = buildCampaignReport({
    cleanup: { passed: cleanup.passed, receiptPath: cleanupPath },
    command: "s3-faults",
    runId: result.runId,
    scenarios: result.report.scenarios.map((scenario) => ({
      name: scenario.kind,
      observables: {
        convergence: scenario.convergence,
        detail: scenario.detail,
        effect: scenario.effect,
        injectionEvidence: scenario.injectionEvidence,
        observed: scenario.observed,
        recovery: scenario.recovery,
      },
      violations: scenario.observed ? [] : [scenario.detail],
    })),
  });
  await writeCampaignReport(reportPath, report);
  if (!report.passed) {
    throw new Error(`S3 fault campaign failed: ${reportPath}`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function removeOption(
  args: readonly string[],
  option: string
): readonly string[] {
  const index = args.indexOf(option);
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function isKnownFlag(value: string): boolean {
  return (
    value === "--proxy-url" ||
    value === "--control-url" ||
    value === "--toxiproxy-url" ||
    value === "--port" ||
    value === "--scenarios" ||
    value === "--s3-url"
  );
}

if (import.meta.main) {
  process.exitCode = await runS3FaultCli(process.argv.slice(2));
}
