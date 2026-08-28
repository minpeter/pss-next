import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_LATENCY_SAMPLES,
  mergeRecentLatencySamples,
} from "./profile-latency-samples";

describe("profile latency sample retention", () => {
  it("keeps only the newest bounded window across churn batches", () => {
    const samples = Array.from(
      { length: MAX_RETAINED_LATENCY_SAMPLES + 904 },
      (_, index) => index
    );

    expect(mergeRecentLatencySamples([], samples)).toEqual(
      samples.slice(-MAX_RETAINED_LATENCY_SAMPLES)
    );
  });
});
