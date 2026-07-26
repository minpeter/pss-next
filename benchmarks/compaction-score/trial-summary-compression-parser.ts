import type { CompressionReport } from "./report";
import type { ReportRole } from "./stability-comparison-types";
import { parseDistribution } from "./trial-summary-distribution-parser";
import { scenarioField } from "./trial-summary-parser-domain";
import {
  arrayField,
  assertUnique,
  field,
  integerField,
  invalid,
  requiredRecord,
} from "./trial-summary-parser-values";

export function parseCompression(
  value: unknown,
  path: string,
  report: ReportRole
): CompressionReport {
  const record = requiredRecord(value, path, report);
  const byHop = arrayField(record, "byHop", `${path}.byHop`, report).map(
    (entry, index) => {
      const entryPath = `${path}.byHop[${index}]`;
      const hopRecord = requiredRecord(entry, entryPath, report);
      return {
        hop: integerField(hopRecord, "hop", `${entryPath}.hop`, report, 1),
        ratio: parseDistribution(
          field(hopRecord, "ratio", `${entryPath}.ratio`, report),
          `${entryPath}.ratio`,
          report
        ),
      };
    }
  );
  if (byHop.length === 0) {
    invalid(`${path}.byHop`, "at least one hop", "empty array", report);
  }

  const byScenario = arrayField(
    record,
    "byScenario",
    `${path}.byScenario`,
    report
  ).map((entry, index) => {
    const entryPath = `${path}.byScenario[${index}]`;
    const scenarioRecord = requiredRecord(entry, entryPath, report);
    return {
      ratio: parseDistribution(
        field(scenarioRecord, "ratio", `${entryPath}.ratio`, report),
        `${entryPath}.ratio`,
        report
      ),
      scenario: scenarioField(scenarioRecord, entryPath, report),
    };
  });
  if (byScenario.length === 0) {
    invalid(
      `${path}.byScenario`,
      "at least one scenario",
      "empty array",
      report
    );
  }

  assertUnique(
    byHop.map(({ hop }) => hop),
    `${path}.byHop`,
    report
  );
  assertUnique(
    byScenario.map(({ scenario }) => scenario),
    `${path}.byScenario`,
    report
  );

  return {
    byHop,
    byScenario,
    ratio: parseDistribution(
      field(record, "ratio", `${path}.ratio`, report),
      `${path}.ratio`,
      report
    ),
    savings: parseDistribution(
      field(record, "savings", `${path}.savings`, report),
      `${path}.savings`,
      report
    ),
  };
}
