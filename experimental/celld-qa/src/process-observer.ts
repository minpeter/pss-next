export type ProcessMetricKind = "celld-native" | "docker-launcher";

export interface ProcessObservation {
  readonly cpuSystemTicks: number;
  readonly cpuUserTicks: number;
  readonly kind: ProcessMetricKind;
  readonly maxRssBytes: number;
  readonly openFiles: number;
}

export type ProcessMetricReport = ProcessObservation;

export function mergeProcessMetrics(
  left: ProcessMetricReport | null,
  right: ProcessMetricReport | null
): ProcessMetricReport | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  if (left.kind !== right.kind) {
    throw new ProcessObservationKindError(left.kind, right.kind);
  }
  return {
    cpuSystemTicks: left.cpuSystemTicks + right.cpuSystemTicks,
    cpuUserTicks: left.cpuUserTicks + right.cpuUserTicks,
    kind: left.kind,
    maxRssBytes: Math.max(left.maxRssBytes, right.maxRssBytes),
    openFiles: Math.max(left.openFiles, right.openFiles),
  };
}

export function processMetricDelta(
  before: ProcessObservation,
  after: ProcessObservation
): ProcessMetricReport {
  if (before.kind !== after.kind) {
    throw new ProcessObservationKindError(before.kind, after.kind);
  }
  return {
    cpuSystemTicks: after.cpuSystemTicks - before.cpuSystemTicks,
    cpuUserTicks: after.cpuUserTicks - before.cpuUserTicks,
    kind: after.kind,
    maxRssBytes: Math.max(before.maxRssBytes, after.maxRssBytes),
    openFiles: Math.max(before.openFiles, after.openFiles),
  };
}

export class ProcessObservationKindError extends Error {
  readonly after: ProcessMetricKind;
  readonly before: ProcessMetricKind;
  readonly name = "ProcessObservationKindError";

  constructor(before: ProcessMetricKind, after: ProcessMetricKind) {
    super(`Process observation kind changed from ${before} to ${after}`);
    this.after = after;
    this.before = before;
  }
}
