import { describe, expect, it } from "vitest";
import { validateExtensionHostOptions } from "./host-validation";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const INVALID_TIMEOUT_MESSAGE =
  "Coding agent extension timeout must be an integer between 0 and 2147483647";

describe("validateExtensionHostOptions", () => {
  it.each([0, MAX_TIMER_DELAY_MS])(
    "accepts the valid timeout boundary %s",
    (timeoutMs) => {
      // Given
      const options = { timeoutMs };

      // When
      const validated = validateExtensionHostOptions([], options);

      // Then
      expect(validated).toEqual([]);
    }
  );

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    -1,
    MAX_TIMER_DELAY_MS + 1,
  ])("rejects the invalid timeout boundary %s", (timeoutMs) => {
    // Given
    const options = { timeoutMs };

    // When
    const validate = () => validateExtensionHostOptions([], options);

    // Then
    expect(validate).toThrow(INVALID_TIMEOUT_MESSAGE);
  });
});
