import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTaskUtilityPartial,
  writeTaskUtilityPartial,
} from "./task-utility-storage";
import type { TaskUtilityCheckpointIdentity } from "./task-utility-types";

const IDENTITY: TaskUtilityCheckpointIdentity = {
  fixtures: [
    "exec-committed-event-telemetry",
    "prompt-template-dollar-escape",
    "workspace-cache-ignore-correction",
  ],
  mode: "live",
  model: "model-a",
  policy: {
    attemptTimeoutMs: 60_000,
    fullControlAttempts: 3,
    validator: "subprocess-v1",
  },
  repetitions: 3,
};

describe("task utility checkpoint identity", () => {
  it.each([
    ["model", { ...IDENTITY, model: "model-b" }],
    ["repetitions", { ...IDENTITY, repetitions: 4 }],
    ["fixtures", { ...IDENTITY, fixtures: [IDENTITY.fixtures[0]] }],
    [
      "policy",
      {
        ...IDENTITY,
        policy: { ...IDENTITY.policy, attemptTimeoutMs: 30_000 },
      },
    ],
  ])("rejects a checkpoint from another %s identity", async (_, mismatch) => {
    // Given
    const output = await mkdtemp(join(tmpdir(), "task-utility-storage-"));
    try {
      await writeTaskUtilityPartial(output, IDENTITY, []);

      // When
      const resumed = loadTaskUtilityPartial(output, mismatch);

      // Then
      await expect(resumed).rejects.toThrow("identity mismatch");
    } finally {
      await rm(output, { force: true, recursive: true });
    }
  });
});
