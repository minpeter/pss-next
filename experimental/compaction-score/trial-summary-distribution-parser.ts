import type { Distribution } from "./report";
import type { ReportRole } from "./stability-comparison-types";
import {
  numberField,
  recordField,
  requiredRecord,
} from "./trial-summary-parser-values";

export function parseDistribution(
  value: unknown,
  path: string,
  report: ReportRole
): Distribution {
  const record = requiredRecord(value, path, report);
  const quantiles = recordField(
    record,
    "quantiles",
    `${path}.quantiles`,
    report
  );
  return {
    max: numberField(record, "max", `${path}.max`, report),
    mean: numberField(record, "mean", `${path}.mean`, report),
    min: numberField(record, "min", `${path}.min`, report),
    quantiles: {
      p50: numberField(quantiles, "p50", `${path}.quantiles.p50`, report),
      p95: numberField(quantiles, "p95", `${path}.quantiles.p95`, report),
    },
    standardDeviation: numberField(
      record,
      "standardDeviation",
      `${path}.standardDeviation`,
      report,
      0
    ),
  };
}
