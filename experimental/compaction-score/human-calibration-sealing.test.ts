import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportHumanCalibration } from "./human-calibration-export";
import {
  armMappingDigest,
  verifyArmMappingDigest,
} from "./human-calibration-sealing";
import { validateHumanCalibrationPacket } from "./human-calibration-validation";

const COORDINATOR_SECRET = "human-calibration-coordinator-secret-alpha-2026";
const MAPPING_HMAC_PATTERN = /"mapping_hmac":"hmac-sha256:[0-9a-f]{64}"/u;
const PACKET_ID_PATTERN = /"packet_id":"([^"]+)"/u;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("human-calibration sealed arm mapping", () => {
  it("emits keyed mapping evidence when exporting with a coordinator secret", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "human-calibration-sealing-"));
    temporaryDirectories.push(root);
    const inputPath = join(root, "quality.json");
    const outputDirectory = join(root, "packet");
    await writeFile(inputPath, JSON.stringify(qualityFixture()));

    // When
    await exportHumanCalibration({
      coordinatorSecret: COORDINATOR_SECRET,
      inputPath,
      outputDirectory,
    });

    // Then
    const evidence = await readFile(
      join(outputDirectory, "sealed", "arm-mapping.hmac.jsonl"),
      "utf8"
    );
    expect(evidence).toMatch(MAPPING_HMAC_PATTERN);
    expect(evidence).not.toContain(COORDINATOR_SECRET);
  });

  it("keeps packet identity stable while changing keyed arm assignment", async () => {
    // Given
    const root = await mkdtemp(
      join(tmpdir(), "human-calibration-determinism-")
    );
    temporaryDirectories.push(root);
    const inputPath = join(root, "quality.json");
    const firstOutput = join(root, "first");
    const repeatOutput = join(root, "repeat");
    const otherOutput = join(root, "other");
    await writeFile(inputPath, JSON.stringify(qualityFixture()));

    // When
    await exportHumanCalibration({
      coordinatorSecret: COORDINATOR_SECRET,
      inputPath,
      outputDirectory: firstOutput,
    });
    await exportHumanCalibration({
      coordinatorSecret: COORDINATOR_SECRET,
      inputPath,
      outputDirectory: repeatOutput,
    });
    await exportHumanCalibration({
      coordinatorSecret: "human-calibration-coordinator-secret-gamma-2026",
      inputPath,
      outputDirectory: otherOutput,
    });

    // Then
    const firstPacket = await readFile(
      join(firstOutput, "annotator", "packets.blinded.jsonl"),
      "utf8"
    );
    expect(
      await readFile(
        join(repeatOutput, "annotator", "packets.blinded.jsonl"),
        "utf8"
      )
    ).toBe(firstPacket);
    const otherPacket = await readFile(
      join(otherOutput, "annotator", "packets.blinded.jsonl"),
      "utf8"
    );
    expect(otherPacket).not.toBe(firstPacket);
    expect(packetId(otherPacket)).toBe(packetId(firstPacket));
    const publicManifest = await readFile(
      join(firstOutput, "manifest.json"),
      "utf8"
    );
    expect(publicManifest).not.toContain(COORDINATOR_SECRET);
    expect(publicManifest).not.toContain("masterSeed");
  });

  it("keeps the coordinator secret out of serialized calibration artifacts", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "human-calibration-artifacts-"));
    temporaryDirectories.push(root);
    const inputPath = join(root, "quality.json");
    const outputDirectory = join(root, "packet");
    await writeFile(inputPath, JSON.stringify(qualityFixture()));

    // When
    await exportHumanCalibration({
      coordinatorSecret: COORDINATOR_SECRET,
      inputPath,
      outputDirectory,
    });

    // Then
    const artifactPaths = [
      join(outputDirectory, "annotator", "packets.blinded.jsonl"),
      join(outputDirectory, "annotator", "labels-template.csv"),
      join(outputDirectory, "annotator", "README.md"),
      join(outputDirectory, "manifest.json"),
      join(outputDirectory, "sealed", "packets.keys.jsonl"),
      join(outputDirectory, "sealed", "arm-mapping.hmac.jsonl"),
    ];
    const artifacts = await Promise.all(
      artifactPaths.map((path) => readFile(path, "utf8"))
    );
    expect(artifacts.join("\n")).not.toContain(COORDINATOR_SECRET);
  });

  it("rejects export before reading input when the coordinator secret is missing", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "human-calibration-secret-"));
    temporaryDirectories.push(root);
    const inputPath = join(root, "quality.json");
    await writeFile(inputPath, JSON.stringify(qualityFixture()));

    // When
    const exportAttempt = exportHumanCalibration({
      coordinatorSecret: "",
      inputPath,
      outputDirectory: join(root, "packet"),
    });

    // Then
    await expect(exportAttempt).rejects.toThrow(
      "Human calibration coordinator secret is required."
    );
  });

  it("rejects sealed mapping evidence with a different coordinator secret", async () => {
    // Given
    const root = await mkdtemp(
      join(tmpdir(), "human-calibration-wrong-secret-")
    );
    temporaryDirectories.push(root);
    const inputPath = join(root, "quality.json");
    const outputDirectory = join(root, "packet");
    await writeFile(inputPath, JSON.stringify(qualityFixture()));
    await exportHumanCalibration({
      coordinatorSecret: COORDINATOR_SECRET,
      inputPath,
      outputDirectory,
    });

    // When
    const validationAttempt = validateHumanCalibrationPacket(
      outputDirectory,
      "human-calibration-coordinator-secret-wrong-2026"
    );

    // Then
    await expect(validationAttempt).rejects.toThrow(
      "Human calibration arm mapping evidence is invalid."
    );
  });
  it("authenticates the displayed candidate assignment", () => {
    const identity = {
      answer: "expected answer",
      automatedMatches: { A: true, B: false },
      candidates: { A: "full candidate", B: "compacted candidate" },
      mapping: "A" as const,
      packetId: "packet-sentinel",
      qid: "q0",
    };
    const digest = armMappingDigest(COORDINATOR_SECRET, identity);

    expect(
      verifyArmMappingDigest(
        COORDINATOR_SECRET,
        {
          ...identity,
          candidates: { A: "compacted candidate", B: "full candidate" },
        },
        digest
      )
    ).toBe(false);
    expect(
      verifyArmMappingDigest(
        COORDINATOR_SECRET,
        { ...identity, answer: "forged answer" },
        digest
      )
    ).toBe(false);
    expect(
      verifyArmMappingDigest(
        COORDINATOR_SECRET,
        { ...identity, automatedMatches: { A: false, B: true } },
        digest
      )
    ).toBe(false);
    const splitAtB = armMappingDigest(COORDINATOR_SECRET, {
      ...identity,
      candidates: { A: "x", B: "y\u0000z" },
    });
    const splitAtA = armMappingDigest(COORDINATOR_SECRET, {
      ...identity,
      candidates: { A: "x\u0000y", B: "z" },
    });
    expect(splitAtA).not.toBe(splitAtB);
  });
});

function packetId(packet: string): string {
  const match = PACKET_ID_PATTERN.exec(packet);
  if (match?.[1] === undefined) {
    throw new TypeError("Calibration packet fixture has no packet id.");
  }
  return match[1];
}

function qualityFixture() {
  return {
    calibrationItems: [
      {
        compactedAnswer: "compacted candidate",
        fullAnswer: "full candidate",
        messages: [{ content: "Release is R-17", role: "user" }],
        questions: [
          {
            answer: "R-17",
            category: "exact-recall",
            question: "Which release?",
          },
        ],
        scenario: "baseline",
        seed: "human-sealing-test",
      },
    ],
    schemaVersion: "quality-sweep-v2",
  };
}
