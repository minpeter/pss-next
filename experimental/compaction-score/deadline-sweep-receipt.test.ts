import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateDeadlineSweepInputEvidence,
  validateDeadlineSweepReceipt,
} from "./deadline-sweep-receipt";
import type { DeadlineSweepReport } from "./deadline-sweep-types";
import { sha256 } from "./human-calibration-utils";

describe("deadline sweep command receipt", () => {
  it("requires the exact completed live arm command", async () => {
    const root = await mkdtemp(join(tmpdir(), "deadline-receipt-test-"));
    const output = join(root, "10000");
    await mkdir(output);
    const receipt = {
      argv: [
        "--",
        "--mode",
        "live",
        "--deadline-ms",
        "10000",
        "--start-repetition",
        "1",
        "--repetitions",
        "10",
        "--output",
        output,
      ],
      completedAt: "2026-08-15T00:01:00.000Z",
      error: null,
      startedAt: "2026-08-15T00:00:00.000Z",
      status: "completed",
    };
    const receiptPath = join(output, "runtime-deadline-outcome-command.json");
    const artifactPath = join(output, "runtime-deadline-outcomes.json");
    try {
      await writeFile(receiptPath, JSON.stringify(receipt));
      await expect(
        validateDeadlineSweepReceipt(artifactPath, 10_000)
      ).resolves.toMatchObject({ sha256: expect.stringContaining("sha256:") });
      await writeFile(
        receiptPath,
        JSON.stringify({ ...receipt, argv: [...receipt.argv, "--extra", "x"] })
      );
      await expect(
        validateDeadlineSweepReceipt(artifactPath, 10_000)
      ).rejects.toThrow("argv is invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a stale artifact hash after the artifact mutates", async () => {
    const fixture = await evidenceFixture();
    try {
      await writeFile(fixture.artifactPath, "mutated artifact");

      await expect(
        validateDeadlineSweepInputEvidence(fixture.report)
      ).rejects.toThrow("artifact hash is stale");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a stale receipt hash after the receipt mutates", async () => {
    const fixture = await evidenceFixture();
    try {
      await writeFile(
        fixture.receiptPath,
        JSON.stringify({
          ...fixture.receipt,
          completedAt: "2026-08-15T00:02:00.000Z",
        })
      );

      await expect(
        validateDeadlineSweepInputEvidence(fixture.report)
      ).rejects.toThrow("receipt hash is stale");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

async function evidenceFixture(): Promise<{
  readonly artifactPath: string;
  readonly receipt: CommandReceipt;
  readonly receiptPath: string;
  readonly report: DeadlineSweepReport;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pss-deadline-evidence-test-"));
  const output = join(root, "10000");
  await mkdir(output);
  const artifactPath = join(output, "runtime-deadline-outcomes.json");
  const receiptPath = join(output, "runtime-deadline-outcome-command.json");
  const artifactContents = "deadline artifact";
  const receipt: CommandReceipt = {
    argv: [
      "--",
      "--mode",
      "live",
      "--deadline-ms",
      "10000",
      "--start-repetition",
      "1",
      "--repetitions",
      "10",
      "--output",
      output,
    ],
    completedAt: "2026-08-15T00:01:00.000Z",
    error: null,
    startedAt: "2026-08-15T00:00:00.000Z",
    status: "completed",
  };
  const receiptContents = JSON.stringify(receipt);
  await Promise.all([
    writeFile(artifactPath, artifactContents),
    writeFile(receiptPath, receiptContents),
  ]);
  return {
    artifactPath,
    receipt,
    receiptPath,
    report: deadlineEvidenceReport(
      artifactPath,
      sha256(artifactContents),
      sha256(receiptContents)
    ),
    root,
  };
}

function deadlineEvidenceReport(
  source: string,
  artifactSha256: string,
  receiptSha256: string
): DeadlineSweepReport {
  return {
    arms: {},
    createdAt: "2026-08-15T00:00:00.000Z",
    deadlinesMs: [10_000],
    historical: null,
    historicalPareto: {},
    inputEvidence: {
      "10000": {
        artifactSha256,
        receiptPolicy: "exact-live-command",
        receiptSha256,
        source,
      },
    },
    methodology: {
      bootstrapIterations: 10_000,
      bootstrapSeed: 15_081,
      pairedResampling: "whole-scenario-repetition-cells",
      rateInterval: "wilson-95",
    },
    mode: "live",
    model: "test-model",
    paired: [],
    pareto: {},
    scenarios: {},
    schemaVersion: "deadline-sweep-v1",
  };
}

interface CommandReceipt {
  readonly argv: readonly string[];
  readonly completedAt: string;
  readonly error: null;
  readonly startedAt: string;
  readonly status: "completed";
}
