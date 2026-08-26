import { readFile } from "node:fs/promises";
import { validateRuntimeDeadlineOutcomeReport } from "./runtime-deadline-outcome-validation";

const args = process.argv.slice(2);
const normalized = args[0] === "--" ? args.slice(1) : args;
const inputIndex = normalized.indexOf("--input");
const input = normalized[inputIndex + 1];
if (inputIndex < 0 || input === undefined || input.length === 0) {
  throw new TypeError(
    "Usage: deadline-outcome-validate --input runtime-deadline-outcome.json"
  );
}
const raw: unknown = JSON.parse(await readFile(input, "utf8"));
const report = validateRuntimeDeadlineOutcomeReport(raw, input);
console.log(
  JSON.stringify({
    attemptErrors: report.summary.audit.attemptErrors,
    cells: report.summary.audit.cells,
    deadlineMs: report.deadlineMs,
    valid: true,
  })
);
