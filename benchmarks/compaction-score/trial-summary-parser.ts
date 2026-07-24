import type { InvalidTrialStatus, TrialSummary } from "./report";
import type {
  ReportRole,
  TrialSummaryInspection,
} from "./stability-comparison-types";
import { parseCompression } from "./trial-summary-compression-parser";
import {
  field,
  InvalidReportFact,
  integerField,
  invalid,
  recordField,
  requiredInteger,
  requiredRecord,
} from "./trial-summary-parser-values";
import { parseRetention } from "./trial-summary-retention-parser";

const INVALID_STATUSES = [
  "compaction-prompt-failure",
  "evaluation-provider-failure",
  "invalid-full-control",
  "non-compressing-summary",
  "protocol-failure",
  "summary-provider-failure",
] as const satisfies readonly InvalidTrialStatus[];

export function inspectTrialSummary(
  value: unknown,
  report: ReportRole
): TrialSummaryInspection {
  try {
    return { summary: parseTrialSummary(value, report), valid: true };
  } catch (cause) {
    if (cause instanceof InvalidReportFact) {
      return { issue: cause.issue, valid: false };
    }
    throw cause;
  }
}

function parseTrialSummary(value: unknown, report: ReportRole): TrialSummary {
  const root = requiredRecord(value, "$", report);
  const trialsRecord = recordField(root, "trials", "$.trials", report);
  const attempted = integerField(
    trialsRecord,
    "attempted",
    "$.trials.attempted",
    report,
    0
  );
  const valid = integerField(
    trialsRecord,
    "valid",
    "$.trials.valid",
    report,
    0
  );
  const invalidByStatus = parseInvalidStatuses(trialsRecord, report);
  const invalidCount = Object.values(invalidByStatus).reduce(
    (total, count) => total + (count ?? 0),
    0
  );
  if (valid + invalidCount !== attempted) {
    invalid(
      "$.trials",
      "valid + invalid counts to equal attempted",
      `${valid} + ${invalidCount} != ${attempted}`,
      report
    );
  }

  const retentionValue = field(root, "retention", "$.retention", report);
  const compressionValue = field(root, "compression", "$.compression", report);
  const retention =
    retentionValue === null
      ? null
      : parseRetention(retentionValue, "$.retention", report);
  const compression =
    compressionValue === null
      ? null
      : parseCompression(compressionValue, "$.compression", report);
  assertMetricPresence(valid, retention, compression, report);

  return {
    compression,
    retention,
    trials: { attempted, invalidByStatus, valid },
  };
}

function parseInvalidStatuses(
  trials: Readonly<Record<string, unknown>>,
  report: ReportRole
): Partial<Record<InvalidTrialStatus, number>> {
  const record = recordField(
    trials,
    "invalidByStatus",
    "$.trials.invalidByStatus",
    report
  );
  const counts: Partial<Record<InvalidTrialStatus, number>> = {};
  for (const [status, count] of Object.entries(record)) {
    const knownStatus = INVALID_STATUSES.find((known) => known === status);
    if (!knownStatus) {
      invalid(
        "$.trials.invalidByStatus",
        "known invalid status keys",
        status,
        report
      );
    }
    counts[knownStatus] = requiredInteger(
      count,
      `$.trials.invalidByStatus.${status}`,
      report,
      0
    );
  }
  return counts;
}

function assertMetricPresence(
  valid: number,
  retention: TrialSummary["retention"],
  compression: TrialSummary["compression"],
  report: ReportRole
): void {
  if (valid > 0 && (retention === null || compression === null)) {
    invalid(
      "$",
      "non-null retention and compression when valid trials exist",
      "null report metrics",
      report
    );
  }
  if (valid === 0 && (retention !== null || compression !== null)) {
    invalid(
      "$",
      "null retention and compression when no valid trials exist",
      "non-null report metrics",
      report
    );
  }
}
