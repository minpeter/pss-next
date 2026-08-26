import { describe, expect, it } from "vitest";
import {
  TASK_VALIDATOR_NETWORK_ISOLATED_ENV,
  taskValidatorSandboxCommand,
} from "./task-utility-sandbox";

describe("task validator sandbox command", () => {
  it("omits inner network setup only for an explicitly isolated parent", async () => {
    const previous = process.env[TASK_VALIDATOR_NETWORK_ISOLATED_ENV];
    process.env[TASK_VALIDATOR_NETWORK_ISOLATED_ENV] = "1";
    try {
      const command = await taskValidatorSandboxCommand({
        fixtureId: "fixture",
        targetFile: "target.mjs",
        validatorEntrypoint: "/tmp/validator.mjs",
        workspace: "/tmp/workspace",
      });
      expect(command.args).not.toContain("--unshare-net");
    } finally {
      if (previous === undefined) {
        delete process.env[TASK_VALIDATOR_NETWORK_ISOLATED_ENV];
      } else {
        process.env[TASK_VALIDATOR_NETWORK_ISOLATED_ENV] = previous;
      }
    }
  });
});
