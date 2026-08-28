import { z } from "zod";
import type { CampaignCommand } from "./campaign-report";

const commandSchema = z.enum(["real-agent", "chaos", "profiles", "s3-faults"]);

export interface CampaignCommonOptions {
  readonly report: string;
}

interface CampaignCommandModule {
  readonly runCampaignCommand: (args: readonly string[]) => Promise<void>;
}

export function normalizeCliArguments(
  args: readonly string[]
): readonly string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

export function requiredStringOption(
  args: readonly string[],
  name: string
): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  return z.string().min(1).parse(value);
}

export function integerOption(
  args: readonly string[],
  name: string,
  fallback: number
): number {
  const index = args.indexOf(name);
  const raw = index < 0 ? undefined : args[index + 1];
  if (raw === undefined) {
    return fallback;
  }
  return z.coerce.number().int().positive().parse(raw);
}

export function csvOption(
  args: readonly string[],
  name: string
): readonly string[] {
  return requiredStringOption(args, name)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseCampaignCommonOptions(
  args: readonly string[]
): CampaignCommonOptions {
  const normalized = normalizeCliArguments(args);
  return {
    report: requiredStringOption(normalized, "--report"),
  };
}

export async function runCampaignCli(
  args: readonly string[] = process.argv.slice(2)
): Promise<number> {
  try {
    const [rawCommand, ...commandArgs] = normalizeCliArguments(args);
    const command = commandSchema.parse(rawCommand);
    const loaded: unknown = await import(`./qa-${command}.ts`);
    if (!isCampaignCommandModule(loaded)) {
      throw new Error(`Campaign module has no runner: ${command}`);
    }
    await loaded.runCampaignCommand(commandArgs);
    return 0;
  } catch (error: unknown) {
    console.error("CELLD_QA_CAMPAIGN_FAILED");
    console.error(error instanceof Error ? error.stack : String(error));
    return 1;
  }
}

function isCampaignCommandModule(
  value: unknown
): value is CampaignCommandModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "runCampaignCommand" in value &&
    typeof value.runCampaignCommand === "function"
  );
}

if (import.meta.main) {
  process.exitCode = await runCampaignCli();
}

export function campaignModulePath(command: CampaignCommand): string {
  return `./qa-${command}.ts`;
}
