interface ComparisonCliOutput {
  readonly failureCodes: readonly string[];
  readonly passed: boolean;
}

export function parseComparisonCliOutput(text: string): ComparisonCliOutput {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("failures" in value) ||
    !Array.isArray(value.failures) ||
    !("passed" in value) ||
    typeof value.passed !== "boolean"
  ) {
    throw new TypeError("Invalid comparison CLI output");
  }

  const failures: readonly unknown[] = value.failures;
  const failureCodes = failures.map((failure) => {
    if (
      typeof failure !== "object" ||
      failure === null ||
      !("code" in failure) ||
      typeof failure.code !== "string"
    ) {
      throw new TypeError("Invalid comparison CLI failure");
    }
    return failure.code;
  });

  return { failureCodes, passed: value.passed };
}
