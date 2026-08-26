import type { FiveTrackReport } from "./five-track-types";

export function renderFiveTrackReport(report: FiveTrackReport): string {
  const lines = [
    "# PSS Runtime 5-track compaction benchmark",
    "",
    "> 단일 종합 점수는 사용하지 않는다. 각 표의 측정값, 추정값, 미측정값을 분리한다.",
    `> Quality output budget은 \`${report.methodology.qualityOutputBudgetEnforcement}\` 방식으로 양 arm에 동일 적용했다.`,
    "> Provider token-limit 인자는 hard cap으로 간주하지 않았고, 양 arm의 deterministic state를 포함한 최종 summary를 local cap한 뒤 평가했다.",
    "",
    "## 증거 provenance",
    "",
    "| Track | Model | Mode | Status | Artifact SHA-256 | Receipt SHA-256 |",
    "|---|---|---|---|---|---|",
    ...Object.values(report.inputs).map(
      (input) =>
        `| ${input.track} | ${input.model ?? "n/a"} | ${input.mode ?? "n/a"} | ${input.status} | ${input.sha256.slice(0, 19)}... | ${input.receiptSha256?.slice(0, 19) ?? "embedded/null"} |`
    ),
    "",
    "## 동일 출력 예산 비교 (측정)",
    "",
    "| Arm | Budget | Retention (Wilson 95%) | Compression | Latency | Valid/Invalid | Cost |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.fairness.matchedOutputBudget.cells.map(
      (cell) =>
        `| ${cell.arm} | ${cell.budget} | ${percent(cell.correct / cell.total)} ${interval(cell.wilson95)} | ${number(cell.compressionRatioMean)} | ${milliseconds(cell.latencyMeanMs)} | ${cell.valid}/${cell.invalid} | 미측정 |`
    ),
    "",
    "## 동일 품질 예산 비교 (추정)",
    "",
    "| Retention target | PSS budget (95%) | pi budget (95%) | pi/PSS ratio (95%) | Bootstrap draws |",
    "|---:|---:|---:|---:|---:|",
    ...report.fairness.matchedQuality.estimates.map(
      (estimate) =>
        `| ${percent(estimate.quality)} | ${estimate.pssBudget.toFixed(1)} ${optionalInterval(estimate.pssBudgetCi95)} | ${estimate.piBudget.toFixed(1)} ${optionalInterval(estimate.piBudgetCi95)} | ${estimate.ratio.toFixed(3)} ${optionalInterval(estimate.ratioCi95)} | ${estimate.bootstrapValidDraws} |`
    ),
    "",
    "## Rate-distortion-latency curve (측정)",
    "",
    "| Arm | Budget | Retention | Compression | Latency | Cost |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.curves.rateDistortionLatency.points.map(
      (point) =>
        `| ${point.arm} | ${point.budget} | ${percent(point.retention)} | ${number(point.compressionRatio)} | ${milliseconds(point.latencyMeanMs)} | 미측정 |`
    ),
    "",
    `Quality Pareto (추정): ${report.pareto.quality.front.join(", ") || "없음"}`,
    "",
    "## Downstream coding-agent utility (측정)",
    "",
    "| Metric | Full control | Compact |",
    "|---|---:|---:|",
    `| Task success | ${rate(report.curves.utility.summary.fullControlSuccess)} | ${rate(report.curves.utility.summary.compactConditionalSuccess)} |`,
    `| Quality | ${rate(report.curves.utility.summary.fullQuality)} | ${rate(report.curves.utility.summary.compactQuality)} |`,
    `| Latency mean (95%) | ${latency(report.curves.utility.summary.fullLatencyMs)} | ${latency(report.curves.utility.summary.compactLatencyMs)} |`,
    "| Cost | 미측정 | 미측정 |",
    "",
    "## 실제 사람 보정 (측정)",
    "",
    `- Annotators: ${report.humanCalibration.annotatorIds.join(", ")}`,
    `- Labels: ${report.humanCalibration.labelCount}`,
    `- Fixture exact agreement: ${percent(report.humanCalibration.humanFixtureAgreement)} ${interval(report.humanCalibration.humanFixtureWilson95)}`,
    `- Candidate semantic agreement: ${percent(report.humanCalibration.semanticAgreement)} ${interval(report.humanCalibration.semanticWilson95)}`,
    `- Multi-rater kappa: ${report.humanCalibration.interRaterKappa?.toFixed(3) ?? "미측정"}`,
    `- Packet digest: ${report.humanCalibration.packetContentDigest}`,
    `- Labels digest: ${report.humanCalibration.labelsContentDigest}`,
    "",
    "## Production speculative-overlap (측정)",
    "",
    "| Scenario | User block mean (95%) | Dispatch block mean (95%) | Candidate applied | Background overlap |",
    "|---|---:|---:|---:|---:|",
    ...report.fairness.fullProduct.productionOverlap.map(
      (aggregate) =>
        `| ${aggregate.scenario} | ${distribution(aggregate.actualUserBlockMs)} | ${distribution(aggregate.dispatchBlockMs)} | ${rate(aggregate.candidateApplied)} | ${rate(aggregate.overlap)} |`
    ),
    "",
    "## Deadline outcomes / Pareto (측정값 기반 추정)",
    "",
    "| Scenario | Deadline | Provider start | Timeout | Candidate applied | Reliability | Decision latency |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...deadlineRows(report),
    "",
    ...Object.entries(report.pareto.deadline.front).map(
      ([scenario, deadlines]) => `- ${scenario}: ${deadlines.join(", ")} ms`
    ),
    "",
    "Cost는 provider 요율이 없어 전 track에서 미측정이며 0으로 대체하지 않았다.",
    "",
  ];
  return lines.join("\n");
}

function deadlineRows(report: FiveTrackReport): readonly string[] {
  return Object.entries(report.fairness.fullProduct.deadlines).flatMap(
    ([scenario, deadlines]) =>
      Object.entries(deadlines).map(
        ([deadline, aggregate]) =>
          `| ${scenario} | ${deadline} | ${rate(aggregate.providerStarted)} | ${rate(aggregate.timeout)} | ${rate(aggregate.candidateApplied)} | ${rate(aggregate.reliability)} | ${distribution(aggregate.decisionLatencyMs)} |`
      )
  );
}

function distribution(value: {
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
}): string {
  return `${value.mean.toFixed(1)} ${interval(value.meanCi95)}`;
}

function latency(value: {
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
}): string {
  return `${value.mean.toFixed(1)} ms ${interval(value.meanCi95)}`;
}

function rate(value: {
  readonly rate: number;
  readonly wilson95: readonly [number, number];
}): string {
  return `${percent(value.rate)} ${interval(value.wilson95)}`;
}

function interval(value: readonly [number, number]): string {
  return `[${value[0].toFixed(3)}, ${value[1].toFixed(3)}]`;
}

function optionalInterval(value: readonly [number, number] | null): string {
  return value === null ? "[추정 불가]" : interval(value);
}

function milliseconds(value: number | null): string {
  return value === null ? "미측정" : `${value.toFixed(1)} ms`;
}

function number(value: number | null): string {
  return value === null ? "미측정" : value.toFixed(3);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
