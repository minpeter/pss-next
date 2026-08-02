import type { ReportFactIssue, ReportRole } from "./stability-comparison-types";

export class InvalidReportFact extends Error {
  readonly issue: ReportFactIssue;

  constructor(issue: ReportFactIssue) {
    super(issue.kind);
    this.issue = issue;
  }
}

export function field(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  report: ReportRole
): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new InvalidReportFact({ kind: "missing", path, report });
  }
  return record[key];
}

export function requiredRecord(
  value: unknown,
  path: string,
  report: ReportRole
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    invalid(path, "object", describe(value), report);
  }
  return value;
}

export function recordField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  report: ReportRole
): Readonly<Record<string, unknown>> {
  return requiredRecord(field(record, key, path, report), path, report);
}

export function arrayField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  report: ReportRole
): readonly unknown[] {
  const value = field(record, key, path, report);
  if (!Array.isArray(value)) {
    invalid(path, "array", describe(value), report);
  }
  return value;
}

export function numberField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  report: ReportRole,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY
): number {
  return requiredNumber(
    field(record, key, path, report),
    path,
    report,
    minimum,
    maximum
  );
}

export function integerField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  report: ReportRole,
  minimum: number
): number {
  return requiredInteger(
    field(record, key, path, report),
    path,
    report,
    minimum
  );
}

export function requiredInteger(
  value: unknown,
  path: string,
  report: ReportRole,
  minimum: number
): number {
  const number = requiredNumber(
    value,
    path,
    report,
    minimum,
    Number.POSITIVE_INFINITY
  );
  if (!Number.isInteger(number)) {
    invalid(path, "integer", String(number), report);
  }
  return number;
}

export function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  report: ReportRole
): string {
  const value = field(record, key, path, report);
  if (!(typeof value === "string" && value.length > 0)) {
    invalid(path, "non-empty string", describe(value), report);
  }
  return value;
}

export function assertUnique(
  values: readonly (number | string)[],
  path: string,
  report: ReportRole
): void {
  if (new Set(values).size !== values.length) {
    invalid(path, "unique rows", "duplicate row", report);
  }
}

export function invalid(
  path: string,
  expected: string,
  actual: string,
  report: ReportRole
): never {
  throw new InvalidReportFact({
    actual,
    expected,
    kind: "invalid",
    path,
    report,
  });
}

function requiredNumber(
  value: unknown,
  path: string,
  report: ReportRole,
  minimum: number,
  maximum: number
): number {
  if (!(typeof value === "number" && Number.isFinite(value))) {
    invalid(path, "finite number", describe(value), report);
  }
  if (value < minimum || value > maximum) {
    invalid(
      path,
      `number from ${minimum} through ${maximum}`,
      String(value),
      report
    );
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
