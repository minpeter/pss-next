import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS } from "./compare-pi-config";
import { runArmWithRetry } from "./compare-pi-judge";
import { isRetryableCompareStatus } from "./compare-pi-retry";
import type { ArmResult } from "./compare-pi-types";

const arm = (status: string): ArmResult => ({ status });

describe("compare-pi retry policy", () => {
  it("retries only transient provider failures", () => {
    // Given / When / Then
    expect(isRetryableCompareStatus("evaluation-provider-failure")).toBe(true);
    expect(isRetryableCompareStatus("summary-provider-failure")).toBe(true);
    expect(isRetryableCompareStatus("invalid-full-control")).toBe(false);
    expect(isRetryableCompareStatus("protocol-failure")).toBe(false);
    expect(isRetryableCompareStatus("valid")).toBe(false);
  });

  it.each(["invalid-full-control", "protocol-failure", "valid"] as const)(
    "returns the first %s result without resampling",
    async (status) => {
      // Given
      const first = arm(status);
      const second = arm(status);
      let attempts = 0;

      // When
      const returned = await runArmWithRetry(() => {
        attempts += 1;
        return Promise.resolve(attempts === 1 ? first : second);
      });

      // Then
      expect(attempts).toBe(1);
      expect(returned).toBe(first);
    }
  );

  it.each(["evaluation-provider-failure", "summary-provider-failure"] as const)(
    "spends the full attempt budget on persistent %s",
    async (status) => {
      // Given
      const attempts: ArmResult[] = Array.from({ length: MAX_ATTEMPTS }, () =>
        arm(status)
      );
      let call = 0;

      // When
      const returned = await runArmWithRetry(() => {
        const result = attempts[call];
        call += 1;
        if (result === undefined) {
          throw new Error(`unexpected extra retry after ${call} calls`);
        }
        return Promise.resolve(result);
      });

      // Then
      expect(call).toBe(MAX_ATTEMPTS);
      expect(returned).toBe(attempts[MAX_ATTEMPTS - 1]);
    }
  );

  it("returns a later valid result after retryable provider failures", async () => {
    // Given
    const first = arm("evaluation-provider-failure");
    const second = arm("valid");
    let attempts = 0;

    // When
    const returned = await runArmWithRetry(() => {
      attempts += 1;
      return Promise.resolve(attempts === 1 ? first : second);
    });

    // Then
    expect(attempts).toBe(2);
    expect(returned).toBe(second);
  });

  it("stops as soon as a later attempt is not a transient provider failure", async () => {
    // Given
    const first = arm("summary-provider-failure");
    const second = arm("protocol-failure");
    const third = arm("evaluation-provider-failure");
    let attempts = 0;

    // When
    const returned = await runArmWithRetry(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(first);
      }
      if (attempts === 2) {
        return Promise.resolve(second);
      }
      return Promise.resolve(third);
    });

    // Then
    expect(attempts).toBe(2);
    expect(returned).toBe(second);
  });
});
