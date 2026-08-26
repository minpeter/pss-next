import { expect, it } from "vitest";
import { formatComparisonReportLocation } from "./compare-pi";

it("reports the actual output path without terminal control characters", () => {
  expect(
    formatComparisonReportLocation(
      "/tmp/report\u001b[31m\n\u2028\u{e0001}/comparison.json"
    )
  ).toBe(
    'report: "/tmp/report\\u001b[31m\\n\\u2028\\udb40\\udc01/comparison.json"'
  );
});
