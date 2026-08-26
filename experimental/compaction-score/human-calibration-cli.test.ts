import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateHumanCalibrationReport } from "./human-calibration-report-validation";
import {
  COORDINATOR_SECRET,
  qualityFixture,
  runHumanCalibration,
} from "./human-calibration-test-support";
import { isRecord } from "./human-calibration-utils";
import { validateHumanCalibrationPacket } from "./human-calibration-validation";

const CLI_TEST_TIMEOUT_MS = 30_000;

describe("human-calibration CLI artifacts", () => {
  it(
    "exports deterministic blinded packets and sealed keys",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pss-human-export-test-"));
      const input = join(root, "quality.json");
      const output = join(root, "packet");
      const secondOutput = join(root, "packet-second");

      try {
        await writeFile(input, JSON.stringify(qualityFixture()));
        await expect(
          runHumanCalibration(["validate-export", "--packet", output])
        ).rejects.toThrow();

        await runHumanCalibration([
          "export",
          "--input",
          input,
          "--output",
          output,
        ]);
        await runHumanCalibration([
          "export",
          "--input",
          input,
          "--output",
          secondOutput,
        ]);
        await runHumanCalibration(["validate-export", "--packet", output]);

        const packet = await readFile(
          join(output, "annotator", "packets.blinded.jsonl"),
          "utf8"
        );
        const keys = await readFile(
          join(output, "sealed", "packets.keys.jsonl"),
          "utf8"
        );
        const instructions = await readFile(
          join(output, "annotator", "README.md"),
          "utf8"
        );
        const manifest: unknown = JSON.parse(
          await readFile(join(output, "manifest.json"), "utf8")
        );
        if (
          !isRecord(manifest) ||
          typeof manifest.instructionsFile !== "string"
        ) {
          throw new TypeError("Invalid human calibration manifest fixture.");
        }

        expect(packet).not.toContain('"answer":"R-17"');
        expect(packet).not.toContain('"compactedAnswer"');
        expect(packet).not.toContain('"fullAnswer"');
        expect(packet).not.toContain('"rng_seed"');
        expect(packet).not.toContain('"arm_order"');
        expect(keys).toContain('"answer":"R-17"');
        expect(instructions).toContain("## 한국어 안내");
        expect(instructions).toContain("human:<id>");
        expect(instructions.toLowerCase()).not.toContain("pss");
        expect(instructions.toLowerCase()).not.toContain("pi runtime");
        expect(manifest.instructionsFile).toBe("annotator/README.md");
        expect(
          await readFile(
            join(secondOutput, "annotator", "packets.blinded.jsonl"),
            "utf8"
          )
        ).toBe(packet);
        expect(
          await readFile(
            join(secondOutput, "sealed", "packets.keys.jsonl"),
            "utf8"
          )
        ).toBe(keys);
        expect(
          await readFile(join(secondOutput, "annotator", "README.md"), "utf8")
        ).toBe(instructions);
        await writeFile(
          join(output, "sealed", "packets.keys.jsonl"),
          `${keys}${keys}`
        );
        await expect(
          runHumanCalibration(["validate-export", "--packet", output])
        ).rejects.toThrow();
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    CLI_TEST_TIMEOUT_MS
  );

  it(
    "scores a schema-valid human-provenance label fixture",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pss-human-score-test-"));
      const packet = join(root, "packet");
      const labels = join(root, "labels.csv");
      const output = join(root, "report");

      try {
        const input = join(root, "quality.json");
        await writeFile(input, JSON.stringify(qualityFixture()));
        await runHumanCalibration([
          "export",
          "--input",
          input,
          "--output",
          packet,
        ]);
        await expect(
          runHumanCalibration([
            "validate-score",
            "--input",
            join(output, "human-calibration.json"),
          ])
        ).rejects.toThrow();
        const evidence = await validateHumanCalibrationPacket(
          packet,
          COORDINATOR_SECRET
        );
        const blinded = evidence.packetMap.values().next().value;
        if (blinded === undefined) {
          throw new TypeError("Human calibration packet fixture is empty.");
        }
        await writeFile(
          labels,
          [
            "packet_id,content_digest,qid,annotator_id,annotator_role,session_id,labeled_at_utc,viewed_arm,human_answer,candidate_match,confidence,difficulty,notes,seconds_spent,protocol_version",
            `${blinded.packet_id},${blinded.content_digest},q0,human:test,primary,s1,2026-08-15T00:00:00.000Z,A,R-17,wrong,5,easy,,12,human-calib-v2`,
            `${blinded.packet_id},${blinded.content_digest},q0,human:test,primary,s1,2026-08-15T00:00:00.000Z,B,R-17,wrong,5,easy,,12,human-calib-v2`,
          ].join("\n")
        );

        await runHumanCalibration([
          "score",
          "--packet",
          packet,
          "--labels",
          labels,
          "--output",
          output,
        ]);
        await runHumanCalibration([
          "validate-score",
          "--input",
          join(output, "human-calibration.json"),
        ]);

        const report: unknown = JSON.parse(
          await readFile(join(output, "human-calibration.json"), "utf8")
        );
        validateHumanCalibrationReport(report);
        if (!isRecord(report)) {
          throw new TypeError("Invalid human calibration report fixture.");
        }

        expect(report).toMatchObject({
          humanFixtureAgreement: 1,
          labelCount: 2,
          protocolVersion: "human-calib-v2",
          semanticAgreement: 0,
        });
        await writeFile(
          join(output, "human-calibration.json"),
          JSON.stringify({ ...report, labelCount: 0 })
        );
        await expect(
          runHumanCalibration([
            "validate-score",
            "--input",
            join(output, "human-calibration.json"),
          ])
        ).rejects.toThrow();
        const completeLabels = await readFile(labels, "utf8");
        const [header, firstLabel] = completeLabels.split("\n");
        await writeFile(labels, [header, firstLabel].join("\n"));
        await expect(
          runHumanCalibration([
            "score",
            "--packet",
            packet,
            "--labels",
            labels,
            "--output",
            output,
          ])
        ).rejects.toThrow();
        await writeFile(
          labels,
          completeLabels.replace(
            blinded.content_digest,
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
          )
        );
        await expect(
          runHumanCalibration([
            "score",
            "--packet",
            packet,
            "--labels",
            labels,
            "--output",
            output,
          ])
        ).rejects.toThrow();
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    CLI_TEST_TIMEOUT_MS
  );
  it("rejects command-line coordinator secrets with a static sentinel", async () => {
    await expect(
      runHumanCalibration(["export", "--secret", COORDINATOR_SECRET])
    ).rejects.toMatchObject({ stderr: "human-calibration-failure\n" });
  });
});
