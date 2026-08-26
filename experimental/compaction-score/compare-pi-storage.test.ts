import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ComparePiIdentity,
  loadComparePiRows,
  writeComparePiRows,
} from "./compare-pi-storage";
import type { ComparisonRow } from "./compare-pi-types";

const IDENTITY: ComparePiIdentity = {
  model: "test-model",
  repetitions: 3,
  summaryMaxOutputTokens: 256,
};

const ROW: ComparisonRow = {
  pi: validArm(),
  pss: validArm(),
  repetition: 1,
  scenario: "baseline",
};

function validArm(): ComparisonRow["pi"] {
  return {
    answers: { compacted: ["answer"], full: ["answer"] },
    hops: [
      {
        compactionMs: 1,
        prefixTokens: 100,
        sentOutputTokens: 256,
        summarizerInputTokens: 80,
        summaryTokens: 20,
      },
    ],
    score: {
      arms: {
        compacted: {
          overall: { correct: 1, total: 1 },
          perCategory: [{ category: "exact-recall", correct: 1, total: 1 }],
        },
        full: {
          overall: { correct: 1, total: 1 },
          perCategory: [{ category: "exact-recall", correct: 1, total: 1 }],
        },
      },
      disagreements: [],
      headline: { correct: 1, total: 1 },
    },
    status: "valid",
  };
}

describe("compare-pi row checkpoints", () => {
  it("round-trips answers and observed output budgets", async () => {
    const output = await mkdtemp(join(tmpdir(), "compare-pi-storage-"));
    try {
      await writeComparePiRows(output, IDENTITY, [ROW]);

      await expect(loadComparePiRows(output, IDENTITY)).resolves.toEqual([ROW]);
    } finally {
      await rm(output, { force: true, recursive: true });
    }
  });

  it("rejects duplicate scenario-repetition rows", async () => {
    const output = await mkdtemp(join(tmpdir(), "compare-pi-storage-"));
    try {
      await expect(
        writeComparePiRows(output, IDENTITY, [ROW, ROW])
      ).rejects.toThrow("duplicate identities");
    } finally {
      await rm(output, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "a valid arm missing answers",
      { ...ROW, pi: { ...ROW.pi, answers: undefined } },
    ],
    [
      "a hop with an impossible output cap",
      {
        ...ROW,
        pi: {
          ...ROW.pi,
          hops: [{ ...ROW.pi.hops?.[0], sentOutputTokens: 0 }],
        },
      },
    ],
    [
      "a score with more correct answers than total",
      {
        ...ROW,
        pi: {
          ...ROW.pi,
          score: { ...ROW.pi.score, headline: { correct: 2, total: 1 } },
        },
      },
    ],
  ])("rejects partial rows containing %s", async (_name, row) => {
    const output = await mkdtemp(join(tmpdir(), "compare-pi-storage-"));
    try {
      await writeFile(
        join(output, "comparison.partial.json"),
        JSON.stringify({
          ...IDENTITY,
          rows: [row],
          schemaVersion: "compare-pi-partial-v3",
        })
      );

      await expect(loadComparePiRows(output, IDENTITY)).rejects.toThrow();
    } finally {
      await rm(output, { force: true, recursive: true });
    }
  });

  it("rejects legacy checkpoints without observed output budgets", async () => {
    const output = await mkdtemp(join(tmpdir(), "compare-pi-storage-"));
    try {
      await writeFile(
        join(output, "comparison.partial.json"),
        JSON.stringify({
          ...IDENTITY,
          rows: [ROW],
          schemaVersion: "compare-pi-partial-v2",
        })
      );

      await expect(loadComparePiRows(output, IDENTITY)).rejects.toThrow(
        "identity mismatch"
      );
    } finally {
      await rm(output, { force: true, recursive: true });
    }
  });
});
