export function isRetryableCompareStatus(status: string): boolean {
  return (
    status === "evaluation-provider-failure" ||
    status === "summary-provider-failure"
  );
}
