import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanupCompleteEvent, writeCleanupReceipt } from "./campaign-cleanup";
import {
  csvOption,
  integerOption,
  normalizeCliArguments,
  requiredStringOption,
} from "./campaign-cli-utils";
import {
  buildCampaignReport,
  type JsonValue,
  writeCampaignReport,
} from "./campaign-report";
import { runLiveProfile } from "./profile-live";
import type { ProfileName } from "./profile-types";

export interface ProfileCliOptions {
  readonly baseUrl: string;
  readonly pid?: number;
  readonly profile: ProfileName;
  readonly progressPath?: string;
}

interface CommandDependencies<T> {
  readonly runChurn: (options: ProfileCliOptions) => Promise<T>;
  readonly runLane: (options: ProfileCliOptions) => Promise<T>;
}

export class InvalidProfileArgumentsError extends Error {
  readonly name = "InvalidProfileArgumentsError";
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid profile arguments: ${reason}`);
    this.reason = reason;
  }
}

export function parseProfileArgs(argv: readonly string[]): ProfileCliOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined) {
      throw new InvalidProfileArgumentsError("expected key/value pairs");
    }
    values.set(key, value);
  }
  const profileValue = values.get("--profile");
  const baseUrl = values.get("--base-url");
  if (!isProfileName(profileValue) || baseUrl === undefined) {
    throw new InvalidProfileArgumentsError(
      "--profile and --base-url are required"
    );
  }
  assertLoopbackUrl(baseUrl);
  const pidValue = values.get("--pid");
  const pid = pidValue === undefined ? undefined : Number(pidValue);
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
    throw new InvalidProfileArgumentsError("--pid must be a positive integer");
  }
  return {
    baseUrl,
    ...(pid === undefined ? {} : { pid }),
    profile: profileValue,
    ...(values.has("--progress")
      ? { progressPath: values.get("--progress") }
      : {}),
  };
}

export function campaignProgressPath(
  args: readonly string[],
  profile: ProfileName,
  profileCount: number
): string | undefined {
  const normalized = normalizeCliArguments(args);
  if (!normalized.includes("--progress")) {
    return;
  }
  const basePath = requiredStringOption(normalized, "--progress");
  return profileCount === 1 ? basePath : `${basePath}.${profile}.jsonl`;
}

export function runProfileCommand<T>(
  options: ProfileCliOptions,
  dependencies: CommandDependencies<T>
): Promise<T> {
  switch (options.profile) {
    case "restart":
      return dependencies.runChurn(options);
    case "hot":
    case "mixed":
    case "soak":
    case "wide":
      return dependencies.runLane(options);
    default:
      return assertNever(options.profile);
  }
}

export async function runCampaignCommand(
  args: readonly string[]
): Promise<void> {
  const normalized = normalizeCliArguments(args);
  const reportPath = requiredStringOption(normalized, "--report");
  const profiles = csvOption(normalized, "--profiles").map(parseProfileName);
  const port = integerOption(normalized, "--port", 16_431);
  const baseIndex = normalized.indexOf("--base-url");
  const baseUrl =
    baseIndex < 0
      ? `http://127.0.0.1:${port}`
      : requiredStringOption(normalized, "--base-url");
  await mkdir(dirname(reportPath), { recursive: true });
  const scenarioReports: {
    readonly name: ProfileName;
    readonly observables: Readonly<Record<string, JsonValue>>;
    readonly violations: readonly string[];
  }[] = [];
  for (const profile of profiles) {
    const progressPath = campaignProgressPath(
      normalized,
      profile,
      profiles.length
    );
    if (progressPath !== undefined) {
      await mkdir(dirname(progressPath), { recursive: true });
    }
    const result = await runLiveProfile({
      baseUrl,
      profile,
      port,
      ...(progressPath === undefined ? {} : { progressPath }),
      reportPath: `${reportPath}.${profile}`,
    });
    const reportJson: JsonValue =
      result.report === null ? null : JSON.parse(JSON.stringify(result.report));
    scenarioReports.push({
      name: profile,
      observables: {
        cleanupPath: result.cleanupPath,
        profile,
        report: reportJson,
        runId: result.runId,
      },
      violations: result.report === null ? ["profile failed"] : [],
    });
  }
  const cleanupPath = `${reportPath}.cleanup.jsonl`;
  await writeCleanupReceipt(cleanupPath, [
    cleanupCompleteEvent({
      containers: 0,
      ports: 0,
      prefixObjects: 0,
      processes: 0,
      proxyFaults: 0,
      watchPaths: 0,
    }),
  ]);
  const report = buildCampaignReport({
    cleanup: { passed: true, receiptPath: cleanupPath },
    command: "profiles",
    runId: randomUUID(),
    scenarios: scenarioReports,
  });
  await writeCampaignReport(reportPath, report);
  if (!report.passed) {
    throw new Error(`Celld profile campaign failed: ${reportPath}`);
  }
  console.log(JSON.stringify(report));
}

function parseProfileName(value: string): ProfileName {
  if (
    value !== "wide" &&
    value !== "hot" &&
    value !== "mixed" &&
    value !== "restart" &&
    value !== "soak"
  ) {
    throw new InvalidProfileArgumentsError(`unknown profile ${value}`);
  }
  return value;
}

function isProfileName(value: string | undefined): value is ProfileName {
  return (
    value === "wide" ||
    value === "hot" ||
    value === "mixed" ||
    value === "restart" ||
    value === "soak"
  );
}

function assertLoopbackUrl(value: string): void {
  const hostname = new URL(value).hostname;
  if (
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "::1"
  ) {
    throw new InvalidProfileArgumentsError("--base-url must be loopback");
  }
}

function assertNever(value: never): never {
  throw new InvalidProfileArgumentsError(`unknown profile ${String(value)}`);
}
