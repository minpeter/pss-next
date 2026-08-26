import type { RetentionReport } from "./report";
import type { ReportRole } from "./stability-comparison-types";
import { parseDistribution } from "./trial-summary-distribution-parser";
import {
  categoryField,
  disagreementArmField,
  scenarioField,
} from "./trial-summary-parser-domain";
import {
  arrayField,
  assertUnique,
  field,
  integerField,
  invalid,
  numberField,
  recordField,
  requiredRecord,
  stringField,
} from "./trial-summary-parser-values";

export function parseRetention(
  value: unknown,
  path: string,
  report: ReportRole
): RetentionReport {
  const record = requiredRecord(value, path, report);
  const aggregate = parseRecall(
    field(record, "aggregate", `${path}.aggregate`, report),
    `${path}.aggregate`,
    report
  );
  const byCategory = arrayField(
    record,
    "byCategory",
    `${path}.byCategory`,
    report
  ).map((entry, index) => {
    const entryPath = `${path}.byCategory[${index}]`;
    const categoryRecord = requiredRecord(entry, entryPath, report);
    return {
      ...parseRecall(categoryRecord, entryPath, report),
      category: categoryField(categoryRecord, entryPath, report),
    };
  });
  const byScenario = arrayField(
    record,
    "byScenario",
    `${path}.byScenario`,
    report
  ).map((entry, index) => {
    const entryPath = `${path}.byScenario[${index}]`;
    const scenarioRecord = requiredRecord(entry, entryPath, report);
    return {
      ...parseRecall(scenarioRecord, entryPath, report),
      scenario: scenarioField(scenarioRecord, entryPath, report),
    };
  });
  if (byCategory.length === 0) {
    invalid(
      `${path}.byCategory`,
      "at least one category",
      "empty array",
      report
    );
  }
  if (byScenario.length === 0) {
    invalid(
      `${path}.byScenario`,
      "at least one scenario",
      "empty array",
      report
    );
  }
  assertUnique(
    byCategory.map(({ category }) => category),
    `${path}.byCategory`,
    report
  );
  assertUnique(
    byScenario.map(({ scenario }) => scenario),
    `${path}.byScenario`,
    report
  );

  const disagreements = arrayField(
    record,
    "disagreements",
    `${path}.disagreements`,
    report
  ).map((entry, index) => {
    const entryPath = `${path}.disagreements[${index}]`;
    const disagreement = requiredRecord(entry, entryPath, report);
    return {
      arm: disagreementArmField(disagreement, entryPath, report),
      category: categoryField(disagreement, entryPath, report),
      count: integerField(
        disagreement,
        "count",
        `${entryPath}.count`,
        report,
        1
      ),
      fingerprint: stringField(
        disagreement,
        "fingerprint",
        `${entryPath}.fingerprint`,
        report
      ),
      scenario: scenarioField(disagreement, entryPath, report),
    };
  });
  assertUnique(
    disagreements.map(({ fingerprint }) => fingerprint),
    `${path}.disagreements`,
    report
  );

  return {
    aggregate,
    byCategory,
    byScenario,
    disagreements,
    trialAccuracy: parseDistribution(
      field(record, "trialAccuracy", `${path}.trialAccuracy`, report),
      `${path}.trialAccuracy`,
      report
    ),
  };
}

function parseRecall(
  value: unknown,
  path: string,
  report: ReportRole
): RetentionReport["aggregate"] {
  const record = requiredRecord(value, path, report);
  const correct = integerField(record, "correct", `${path}.correct`, report, 0);
  const total = integerField(record, "total", `${path}.total`, report, 1);
  const accuracy = numberField(
    record,
    "accuracy",
    `${path}.accuracy`,
    report,
    0,
    1
  );
  if (Math.abs(accuracy - correct / total) > Number.EPSILON * 4) {
    invalid(`${path}.accuracy`, "correct / total", String(accuracy), report);
  }
  const wilsonRecord = recordField(
    record,
    "wilson95",
    `${path}.wilson95`,
    report
  );
  return {
    accuracy,
    correct,
    total,
    wilson95: {
      high: numberField(
        wilsonRecord,
        "high",
        `${path}.wilson95.high`,
        report,
        0,
        1
      ),
      low: numberField(
        wilsonRecord,
        "low",
        `${path}.wilson95.low`,
        report,
        0,
        1
      ),
    },
  };
}
