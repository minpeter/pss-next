import {
  array,
  finite,
  object,
  positiveInteger,
  string,
} from "./production-overlap-parse";

export function validateHumanCalibrationReport(raw: unknown): void {
  const report = object(raw, "human calibration");
  const labels = positiveInteger(report.labelCount, "human labelCount");
  if (
    report.schemaVersion !== "human-calibration-v1" ||
    report.protocolVersion !== "human-calib-v2" ||
    report.provenancePolicy !== "declared-actual-human-no-automation" ||
    !string(report.packetContentDigest, "human packet digest").startsWith(
      "sha256:"
    ) ||
    !string(report.labelsContentDigest, "human labels digest").startsWith(
      "sha256:"
    ) ||
    array(report.annotatorIds, "human annotators").length === 0 ||
    array(report.sessionIds, "human sessions").length === 0 ||
    array(report.labeledAtUtcRange, "human time range").length !== 2
  ) {
    throw new TypeError("Human calibration provenance is invalid.");
  }
  validateRate(report.humanFixtureAgreement, report.humanFixtureWilson95);
  validateRate(report.semanticAgreement, report.semanticWilson95);
  const confusion = object(report.confusion, "human confusion");
  const confusionCount = [
    "falseNegative",
    "falsePositive",
    "trueNegative",
    "truePositive",
  ].reduce(
    (total, field) =>
      total + nonnegativeInteger(confusion[field], `confusion.${field}`),
    0
  );
  if (
    confusionCount > labels ||
    (report.interRaterKappa !== null &&
      !Number.isFinite(report.interRaterKappa))
  ) {
    throw new TypeError("Human calibration metrics are invalid.");
  }
  const calibrationCount = array(
    report.calibrationByConfidence,
    "confidence calibration"
  ).reduce<number>(
    (total, row) =>
      total +
      positiveInteger(object(row, "confidence row").count, "confidence count"),
    0
  );
  if (calibrationCount !== labels) {
    throw new TypeError("Human confidence calibration is incomplete.");
  }
}

function validateRate(value: unknown, interval: unknown): void {
  const rate = finite(value, "rate");
  const ci = array(interval, "rate interval");
  if (
    rate < 0 ||
    rate > 1 ||
    ci.length !== 2 ||
    ci.some((bound) => !Number.isFinite(bound))
  ) {
    throw new TypeError("Human calibration rate is invalid.");
  }
}

function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${path} must be a nonnegative integer.`);
  }
  return parsed;
}
