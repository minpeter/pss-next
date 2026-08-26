import { describe, expect, it } from "vitest";
import { parseProductionOverlapOptions } from "./production-overlap-options";

describe("production overlap options", () => {
  it("uses an explicit sixty-second live compaction deadline", () => {
    const options = parseProductionOverlapOptions([
      "--mode",
      "live",
      "--repetitions",
      "10",
      "--output",
      "/tmp/production-overlap-live",
    ]);

    expect(options.compactionDeadlineMs).toBe(60_000);
  });
});
