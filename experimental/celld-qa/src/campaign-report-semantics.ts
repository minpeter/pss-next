import type { CampaignCommand, JsonValue } from "./campaign-report";

type Observables = Readonly<Record<string, JsonValue>>;

export function campaignEvidenceViolations(
  command: CampaignCommand,
  name: string,
  observables: Observables
): readonly string[] {
  switch (command) {
    case "real-agent":
      return realAgentViolations(name, observables);
    case "chaos":
      return chaosViolations(name, observables);
    case "profiles":
      return profileViolations(name, observables);
    case "s3-faults":
      return s3Violations(observables);
    default:
      return assertNever(command);
  }
}

function realAgentViolations(
  name: string,
  observables: Observables
): readonly string[] {
  if (observables.passed !== true) {
    return ["real-agent scenario did not pass"];
  }
  switch (name) {
    case "tool-checkpoint-restart":
      return truth(
        observables.checkpointed === true &&
          observables.leaseRecovery === "checkpoint-proven-orphan-release" &&
          observables.resumedSameRun === true &&
          observables.sideEffectCount === 1 &&
          observables.toolExecutionCount === 2 &&
          observables.terminalResultCount === 1,
        "tool checkpoint recovery evidence is incomplete"
      );
    case "input-ordering":
      return truth(
        stringArrayEquals(observables.inputSources, [
          "send",
          "steer",
          "follow-up",
          "follow-up",
          "notify",
        ]),
        "durable input ordering evidence is incomplete"
      );
    case "compaction-restart":
      return truth(
        observables.automaticCompactions === 1 &&
          observables.manualStatus === "compacted" &&
          stringArrayEquals(observables.continuityMarkers, [
            "CMP-A",
            "CMP-B",
            "CMP-C",
          ]),
        "compaction restart evidence is incomplete"
      );
    case "large-history":
      return truth(
        observables.chunked === true &&
          observables.payloadBytes === 32_768 &&
          stringArrayEquals(observables.markers, [
            "LARGE-00",
            "LARGE-01",
            "LARGE-02",
            "LARGE-03",
          ]),
        "large history evidence is incomplete"
      );
    case "attachment-lifecycle":
      return truth(
        observables.normalized === true &&
          observables.persistedReference === true &&
          observables.hydratedByteLength === 68 &&
          observables.hydratedMediaType === "image/png",
        "attachment lifecycle evidence is incomplete"
      );
    default:
      return [];
  }
}

function chaosViolations(
  name: string,
  observables: Observables
): readonly string[] {
  switch (name) {
    case "alarm-boundaries":
      return truth(
        observables.testsPassed === true &&
          stringArrayEquals(observables.testFiles, [
            "src/platform/celld/scheduler-chaos.test.ts",
            "src/platform/celld/drainer-chaos.test.ts",
          ]),
        "scheduler boundary evidence is incomplete"
      );
    case "ordering":
      return truth(
        observables.testsPassed === true &&
          stringArrayEquals(observables.testFiles, [
            "src/platform/celld/scheduler-ordering.test.ts",
          ]),
        "scheduler ordering evidence is incomplete"
      );
    case "migration":
      return truth(
        observables.celldTestsPassed === true &&
          observables.cloudflareTestsPassed === true &&
          stringArrayEquals(observables.celldTestFiles, [
            "src/platform/celld/scheduled-work-migration.test.ts",
          ]) &&
          stringArrayEquals(observables.cloudflareTestFiles, [
            "src/platform/cloudflare/host/scheduler-contract.test.ts",
            "src/platform/cloudflare/storage/execution/store-transaction.test.ts",
            "src/platform/cloudflare/storage/sqlite/bootstrap.test.ts",
          ]),
        "migration regression evidence is incomplete"
      );
    default:
      return [];
  }
}

function profileViolations(
  name: string,
  observables: Observables
): readonly string[] {
  const report = observables.report;
  if (observables.profile !== name || !isRecord(report)) {
    return ["profile evidence is not attributed to its scenario"];
  }
  const cleanup = report.cleanup;
  const valid =
    observables.cleanupPassed === true &&
    typeof observables.cleanupPath === "string" &&
    observables.cleanupPath.length > 0 &&
    typeof observables.runId === "string" &&
    observables.runId.length > 0 &&
    isRecord(cleanup) &&
    cleanup.drained === true &&
    cleanup.inFlight === 0 &&
    cleanup.aborted === 0 &&
    nonnegativeInteger(report.admitted) &&
    nonnegativeInteger(report.completed) &&
    nonnegativeInteger(report.correct) &&
    report.correct === report.completed &&
    report.completed === report.admitted &&
    report.failed === 0 &&
    report.incorrect === 0;
  return truth(valid, "profile evidence did not fully converge");
}

function s3Violations(observables: Observables): readonly string[] {
  return truth(
    observables.observed === true &&
      observables.injectionEvidence === true &&
      observables.recovery === true &&
      observables.convergence === true &&
      observables.effect === "exactly_once",
    "S3 fault evidence is incomplete"
  );
}

function truth(value: boolean, message: string): readonly string[] {
  return value ? [] : [message];
}

function nonnegativeInteger(value: JsonValue | undefined): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(
  value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayEquals(
  value: JsonValue | undefined,
  expected: readonly string[]
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled campaign command: ${value}`);
}
