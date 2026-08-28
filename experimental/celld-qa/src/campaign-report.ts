import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { campaignEvidenceViolations } from "./campaign-report-semantics";

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

const REQUIRED_SCENARIOS = {
  "real-agent": [
    "tool-checkpoint-restart",
    "input-ordering",
    "compaction-restart",
    "large-history",
    "attachment-lifecycle",
  ],
  chaos: ["alarm-boundaries", "ordering", "migration"],
  profiles: ["wide", "hot", "mixed", "restart", "soak"],
  "s3-faults": [
    "latency",
    "timeout",
    "reset",
    "http_500",
    "localstack_restart",
    "throttle_429",
    "read_after_write",
    "conditional_412",
  ],
} as const;

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
    const expectedViolations = report.scenarios.flatMap((scenario) =>
      scenario.violations.map((violation) => `${scenario.name}: ${violation}`)
    );
    const expected =
      report.cleanup.passed &&
      expectedViolations.length === 0 &&
      report.scenarios.every((scenario) => scenario.passed);
    if (report.passed !== expected) {
      context.addIssue({
        code: "custom",
        message: "Report passed must be derived from scenarios and cleanup.",
      });
    }
    if (
      JSON.stringify(report.violations) !== JSON.stringify(expectedViolations)
    ) {
      context.addIssue({
        code: "custom",
        message: "Report violations must be derived from scenarios.",
      });
    }

    const required: readonly string[] = REQUIRED_SCENARIOS[report.command];
    const names = report.scenarios.map((scenario) => scenario.name);
    const invalidMatrix =
      names.length !== required.length ||
      required.some((name) => !names.includes(name)) ||
      new Set(names).size !== names.length;
    if (invalidMatrix) {
      context.addIssue({
        code: "custom",
        message: `Incomplete ${report.command} scenario matrix.`,
      });
    }
    for (const scenario of report.scenarios) {
      const semanticViolations = campaignEvidenceViolations(
        report.command,
        scenario.name,
        scenario.observables
      );
      if (
        semanticViolations.some(
          (violation) => !scenario.violations.includes(violation)
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `${scenario.name} omits required semantic violations.`,
        });
      }
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
  const scenarios = input.scenarios.map((scenario) => {
    const violations = [
      ...new Set([
        ...scenario.violations,
        ...campaignEvidenceViolations(
          input.command,
          scenario.name,
          scenario.observables
        ),
      ]),
    ];
    return { ...scenario, passed: violations.length === 0, violations };
  });
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
