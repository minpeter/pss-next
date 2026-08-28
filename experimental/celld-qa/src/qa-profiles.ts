import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  csvOption,
  integerOption,
  normalizeCliArguments,
  requiredStringOption,
} from "./campaign-cli-utils";
import type { JsonValue } from "./campaign-report";
import {
  type ProfileCampaignScenario,
  writeProfileCampaignReport,
} from "./profile-campaign-report";
import { withProfileCelldEnvironment } from "./profile-celld-environment";
import { runLiveProfile } from "./profile-live";
import type { ProfileReport } from "./profile-runner";
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

export function campaignBaseUrl(args: readonly string[], port: number): string {
  const baseIndex = args.indexOf("--base-url");
  const baseUrl =
    baseIndex < 0
      ? `http://127.0.0.1:${port}`
      : requiredStringOption(args, "--base-url");
  assertLoopbackUrl(baseUrl);
  const expectedBaseUrl = `http://127.0.0.1:${port}/`;
  if (new URL(baseUrl).href !== expectedBaseUrl) {
    throw new InvalidProfileArgumentsError(
      "--base-url must match the measured Celld port"
    );
  }
  return baseUrl;
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

export function profileViolations(
  report: ProfileReport | null,
  cleanupPassed: boolean
): readonly string[] {
  if (report === null) {
    return ["profile failed"];
  }
  const violations: string[] = [];
  if (report.failed > 0) {
    violations.push(`${report.failed} requests failed`);
  }
  if (report.incorrect > 0) {
    violations.push(`${report.incorrect} responses were incorrect`);
  }
  if (report.correct !== report.completed) {
    violations.push(
      `${report.correct} of ${report.completed} completed requests were correct`
    );
  }
  if (report.completed !== report.admitted) {
    violations.push(
      `${report.completed} of ${report.admitted} admitted requests completed`
    );
  }
  if (!report.cleanup.drained) {
    violations.push("profile cleanup did not drain");
  }
  if (report.cleanup.inFlight !== 0) {
    violations.push(`${report.cleanup.inFlight} requests remained in flight`);
  }
  if (report.cleanup.aborted !== 0) {
    violations.push(`${report.cleanup.aborted} requests were aborted`);
  }
  if (!cleanupPassed) {
    violations.push("profile cleanup left owned resources");
  }
  return violations;
}

export async function runCampaignCommand(
  args: readonly string[]
): Promise<void> {
  const normalized = normalizeCliArguments(args);
  const reportPath = requiredStringOption(normalized, "--report");
  const profiles = csvOption(normalized, "--profiles").map(parseProfileName);
  const port = integerOption(normalized, "--port", 16_431);
  const baseUrl = campaignBaseUrl(normalized, port);
  await mkdir(dirname(reportPath), { recursive: true });
  const scenarioReports: ProfileCampaignScenario[] = [];
  for (const profile of profiles) {
    const progressPath = campaignProgressPath(
      normalized,
      profile,
      profiles.length
    );
    if (progressPath !== undefined) {
      await mkdir(dirname(progressPath), { recursive: true });
    }
    const result = await withProfileCelldEnvironment(process.env, profile, () =>
      runLiveProfile({
        baseUrl,
        profile,
        port,
        ...(progressPath === undefined ? {} : { progressPath }),
        reportPath: `${reportPath}.${profile}`,
      })
    );
    const reportJson: JsonValue =
      result.report === null ? null : JSON.parse(JSON.stringify(result.report));
    scenarioReports.push({
      name: profile,
      observables: {
        cleanupPath: result.cleanupPath,
        cleanupPassed: result.cleanupPassed,
        profile,
        report: reportJson,
        runId: result.runId,
      },
      violations: profileViolations(result.report, result.cleanupPassed),
    });
  }
  const report = await writeProfileCampaignReport(reportPath, scenarioReports);
  if (!report.passed) {
    throw new Error(`Celld profile campaign failed: ${reportPath}`);
  }
  console.log(JSON.stringify(report));
}

function parseProfileName(value: string): ProfileName {
  if (value === "restart-churn") {
    return "restart";
  }
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
