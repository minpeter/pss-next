export function isCorrectProfileResponse(
  payload: unknown,
  expectedText: string
): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "ok" in payload &&
    payload.ok === true &&
    "reply" in payload &&
    payload.reply === `echo:${expectedText}` &&
    "historyCount" in payload &&
    isPositiveInteger(payload.historyCount) &&
    "commitCount" in payload &&
    isPositiveInteger(payload.commitCount)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
