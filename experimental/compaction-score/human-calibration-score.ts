import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  finiteMean,
  finiteRatio,
  finiteSum,
  finiteWilson95,
} from "./finite-statistics";
import { parseHumanLabels } from "./human-calibration-csv";
import {
  type CalibrationKey,
  HUMAN_CALIBRATION_PROTOCOL,
  type HumanCalibrationReport,
  type HumanLabel,
} from "./human-calibration-types";
import { normalizeCalibrationAnswer, sha256 } from "./human-calibration-utils";
import { loadHumanCalibrationEvidence } from "./human-calibration-validation";

interface ScoredLabel {
  readonly exact: boolean;
  readonly label: HumanLabel;
  readonly semantic: boolean;
}

export async function scoreHumanCalibration({
  labelsPath,
  outputDirectory,
  packetDirectory,
}: {
  readonly labelsPath: string;
  readonly outputDirectory: string;
  readonly packetDirectory: string;
}): Promise<HumanCalibrationReport> {
  const labelsContents = await readFile(labelsPath, "utf8");
  const labels = parseHumanLabels(labelsContents);
  if (labels.length === 0) {
    throw new TypeError("Human calibration requires at least one label.");
  }
  const evidence = await loadHumanCalibrationEvidence(packetDirectory, labels);
  const { keyMap } = evidence;
  const scored = labels.map((label) => {
    const key = keyMap.get(labelId(label));
    if (key === undefined) {
      throw new TypeError("Human calibration key is missing.");
    }
    return {
      exact:
        normalizeCalibrationAnswer(label.humanAnswer) ===
        normalizeCalibrationAnswer(key.answer),
      label,
      semantic:
        label.candidateMatch === "exact" || label.candidateMatch === "equiv",
    };
  });
  const exact = scored.filter((item) => item.exact).length;
  const semantic = scored.filter((item) => item.semantic).length;
  const labeledAt = labels.map((label) => label.labeledAtUtc).sort();
  const firstLabeledAt = labeledAt[0];
  const lastLabeledAt = labeledAt.at(-1);
  if (firstLabeledAt === undefined || lastLabeledAt === undefined) {
    throw new TypeError("Human calibration requires at least one label.");
  }
  const report: HumanCalibrationReport = {
    annotatorIds: [...new Set(labels.map((label) => label.annotatorId))].sort(),
    calibrationByConfidence: calibrationByConfidence(scored),
    confusion: confusion(scored, keyMap),
    createdAt: new Date().toISOString(),
    humanFixtureAgreement: finiteRatio(exact, labels.length),
    humanFixtureWilson95: finiteWilson95(exact, labels.length),
    interRaterKappa: interRaterKappa(scored),
    labelCount: labels.length,
    labeledAtUtcRange: [firstLabeledAt, lastLabeledAt],
    labelsContentDigest: sha256(labelsContents),
    packetContentDigest: evidence.contentDigest,
    protocolVersion: HUMAN_CALIBRATION_PROTOCOL,
    provenancePolicy: "declared-actual-human-no-automation",
    semanticAgreement: finiteRatio(semantic, labels.length),
    semanticWilson95: finiteWilson95(semantic, labels.length),
    sessionIds: [...new Set(labels.map((label) => label.sessionId))].sort(),
    schemaVersion: "human-calibration-v1",
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(outputDirectory, "human-calibration.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    writeFile(
      join(outputDirectory, "human-calibration.md"),
      renderHumanCalibration(report)
    ),
  ]);
  return report;
}

function calibrationByConfidence(
  labels: readonly ScoredLabel[]
): HumanCalibrationReport["calibrationByConfidence"] {
  const levels = [
    ...new Set(labels.map(({ label }) => label.confidence)),
  ].sort();
  return levels.map((confidence) => {
    const matching = labels.filter(
      ({ label }) => label.confidence === confidence
    );
    return {
      accuracy: finiteRatio(
        matching.filter((item) => item.semantic).length,
        matching.length
      ),
      confidence,
      count: matching.length,
    };
  });
}

function confusion(
  labels: readonly ScoredLabel[],
  keys: ReadonlyMap<string, CalibrationKey>
): HumanCalibrationReport["confusion"] {
  const result = {
    falseNegative: 0,
    falsePositive: 0,
    trueNegative: 0,
    truePositive: 0,
  };
  for (const item of labels) {
    const automated = keys.get(labelId(item.label))?.automatedMatches[
      item.label.viewedArm
    ];
    if (automated === undefined) {
      continue;
    }
    const human = item.semantic;
    if (automated && human) {
      result.truePositive += 1;
    } else if (automated) {
      result.falsePositive += 1;
    } else if (human) {
      result.falseNegative += 1;
    } else {
      result.trueNegative += 1;
    }
  }
  return result;
}

function interRaterKappa(labels: readonly ScoredLabel[]): number | null {
  const groups = new Map<string, ScoredLabel[]>();
  for (const item of labels) {
    const { label } = item;
    const id = `${label.packetId}:${label.qid}:${label.viewedArm}`;
    const group = groups.get(id) ?? [];
    group.push(item);
    groups.set(id, group);
  }
  const rated = [...groups.values()].filter((group) => group.length >= 2);
  if (rated.length === 0) {
    return null;
  }
  const agreementRates = rated.map((group) => {
    const counts = categoryCounts(group);
    const agreements = finiteSum(
      [...counts.values()].map((count) => count * (count - 1))
    );
    return finiteRatio(agreements, group.length * (group.length - 1));
  });
  const observed = finiteMean(agreementRates);
  const allLabels = rated.flat();
  const marginals = categoryCounts(allLabels);
  const expected = finiteSum(
    [...marginals.values()].map(
      (count) => finiteRatio(count, allLabels.length) ** 2
    )
  );
  return expected === 1 ? 1 : finiteRatio(observed - expected, 1 - expected);
}

function categoryCounts(
  labels: readonly ScoredLabel[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { label } of labels) {
    counts.set(
      label.candidateMatch,
      (counts.get(label.candidateMatch) ?? 0) + 1
    );
  }
  return counts;
}

function labelId(label: HumanLabel): string {
  return `${label.packetId}:${label.qid}`;
}

function renderHumanCalibration(report: HumanCalibrationReport): string {
  return [
    "# Human calibration",
    "",
    `- Labels: ${report.labelCount}`,
    `- Labels digest: ${report.labelsContentDigest}`,
    `- Annotators: ${report.annotatorIds.join(", ")}`,
    `- Packet digest: ${report.packetContentDigest}`,
    `- Provenance: ${report.provenancePolicy}`,
    `- Exact agreement: ${(report.humanFixtureAgreement * 100).toFixed(1)}%`,
    `- Exact Wilson 95%: ${(report.humanFixtureWilson95[0] * 100).toFixed(1)}%-${(report.humanFixtureWilson95[1] * 100).toFixed(1)}%`,
    `- Semantic agreement: ${(report.semanticAgreement * 100).toFixed(1)}%`,
    `- Semantic Wilson 95%: ${(report.semanticWilson95[0] * 100).toFixed(1)}%-${(report.semanticWilson95[1] * 100).toFixed(1)}%`,
    `- Inter-rater kappa: ${report.interRaterKappa?.toFixed(3) ?? "n/a"}`,
    "",
    "| Confidence | Count | Candidate semantic accuracy |",
    "|---:|---:|---:|",
    ...report.calibrationByConfidence.map(
      (row) =>
        `| ${row.confidence} | ${row.count} | ${(row.accuracy * 100).toFixed(1)}% |`
    ),
    "",
  ].join("\n");
}
