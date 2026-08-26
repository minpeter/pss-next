import { describe, expect, it } from "vitest";
import {
  completeTaskValidation,
  TaskValidatorProcessError,
} from "./task-utility-validator-protocol";

describe("task validator protocol boundary", () => {
  it("does not reflect malformed workspace protocol text", () => {
    const malicious = "WORKSPACE_SECRET\u001b[2J";
    expect(() =>
      completeTaskValidation({
        code: 0,
        details: { stderr: "", stdout: "" },
        expectedCheckIds: ["scope"],
        failure: undefined,
        protocol: `{"kind":"challenge","nonce":"n"}\n{${malicious}`,
        signal: null,
        spawnError: undefined,
      })
    ).toThrowError(
      expect.objectContaining({
        kind: "protocol",
        message: "Validator protocol payload is invalid.",
      })
    );
    try {
      completeTaskValidation({
        code: 0,
        details: { stderr: "", stdout: "" },
        expectedCheckIds: ["scope"],
        failure: undefined,
        protocol: `{"kind":"challenge","nonce":"n"}\n{${malicious}`,
        signal: null,
        spawnError: undefined,
      });
    } catch (error) {
      if (!(error instanceof TaskValidatorProcessError)) {
        throw error;
      }
      expect(error.message).not.toContain(malicious);
    }
  });
});
