import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

const scenarioSchema = z
  .object({
    name: z.string().min(1),
    observables: z.record(z.string(), jsonValueSchema),
    passed: z.boolean(),
    violations: z.array(z.string().min(1)),
  })
  .superRefine((scenario, context) => {
    if (scenario.passed !== (scenario.violations.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Scenario passed must be derived from violations.",
      });
    }
  });

const campaignReportSchema = z
  .object({
    cleanup: z.object({
      passed: z.boolean(),
      receiptPath: z.string().min(1),
    }),
    command: z.enum(["real-agent", "chaos", "profiles", "s3-faults"]),
    passed: z.boolean(),
    runId: z.string().min(1),
    scenarios: z.array(scenarioSchema).min(1),
    schemaVersion: z.literal(1),
    violations: z.array(z.string().min(1)),
  })
  .superRefine((report, context) => {
    const expected =
      report.cleanup.passed &&
      report.violations.length === 0 &&
      report.scenarios.every((scenario) => scenario.passed);
    if (report.passed !== expected) {
      context.addIssue({
        code: "custom",
        message: "Report passed must be derived from scenarios and cleanup.",
      });
    }
  });

export type CampaignCommand = z.infer<typeof campaignReportSchema>["command"];
export type CampaignReport = z.infer<typeof campaignReportSchema>;

export interface CampaignReportInput {
  readonly cleanup: CampaignReport["cleanup"];
  readonly command: CampaignCommand;
  readonly runId: string;
  readonly scenarios: readonly {
    readonly name: string;
    readonly observables: Readonly<Record<string, JsonValue>>;
    readonly violations: readonly string[];
  }[];
}

export function buildCampaignReport(
  input: CampaignReportInput
): CampaignReport {
  const scenarios = input.scenarios.map((scenario) => ({
    ...scenario,
    passed: scenario.violations.length === 0,
  }));
  const violations = scenarios.flatMap((scenario) =>
    scenario.violations.map((violation) => `${scenario.name}: ${violation}`)
  );
  return campaignReportSchema.parse({
    cleanup: input.cleanup,
    command: input.command,
    passed:
      input.cleanup.passed &&
      violations.length === 0 &&
      scenarios.every((scenario) => scenario.passed),
    runId: input.runId,
    scenarios,
    schemaVersion: 1,
    violations,
  });
}

export function parseCampaignReport(value: unknown): CampaignReport {
  return campaignReportSchema.parse(value);
}

export async function readCampaignReport(
  path: string
): Promise<CampaignReport> {
  return parseCampaignReport(JSON.parse(await readFile(path, "utf8")));
}

export async function writeCampaignReport(
  path: string,
  report: CampaignReport
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report)}\n`, "utf8");
  await rename(temporary, path);
}
