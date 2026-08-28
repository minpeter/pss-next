import type {
  FaultKind,
  RequestDecisionEvent,
  ScenarioResult,
} from "./fault-proxy-types";

export interface FaultWorkerResult {
  readonly commitCount: number | null;
  readonly elapsedMs: number;
  readonly ok: boolean;
  readonly reply: string | null;
  readonly status: number | null;
}

export interface FaultScenarioRuntime {
  readonly activate: (kind: FaultKind) => Promise<number>;
  readonly deactivate: (kind: FaultKind) => Promise<void>;
  readonly events: () => Promise<readonly RequestDecisionEvent[]>;
  readonly request: (kind: FaultKind) => Promise<FaultWorkerResult>;
}

export async function runFaultScenario(
  kind: FaultKind,
  runtime: FaultScenarioRuntime
): Promise<ScenarioResult> {
  const generation = await runtime.activate(kind);
  let faulted: FaultWorkerResult;
  let afterFault: readonly RequestDecisionEvent[];
  try {
    faulted = await runtime.request(kind);
    if (kind === "read_after_write") {
      faulted = await runtime.request(kind);
    }
    afterFault = await runtime.events();
  } finally {
    await runtime.deactivate(kind);
  }
  const injected = afterFault.filter(
    (event) => event.generation === generation
  );
  const injectionEvidence = observedInjection(kind, faulted, injected);
  const recovered = await runtime.request(kind);
  const converged = await runtime.request(kind);
  const expectedReply = `echo:fault-${kind}`;
  const recovery = isExactlyOnce(recovered, expectedReply);
  const convergence = recovery && isExactlyOnce(converged, expectedReply);
  const effect = convergence ? "exactly_once" : "none";
  return Object.freeze({
    convergence,
    detail: [
      `${kind}:fault=${describe(faulted)}`,
      `recovery=${describe(recovered)}`,
      `convergence=${describe(converged)}`,
      `generation=${generation}`,
    ].join(";"),
    effect,
    injectionEvidence,
    kind,
    observed: injectionEvidence && recovery && convergence,
    recovery,
  });
}

function observedInjection(
  kind: FaultKind,
  result: FaultWorkerResult,
  events: readonly RequestDecisionEvent[]
): boolean {
  if (kind === "latency") {
    return result.elapsedMs >= 125 && events.length > 0;
  }
  return events.some(
    (event) =>
      event.synthetic ||
      event.error !== null ||
      (event.status !== null && event.status >= 400)
  );
}

function isExactlyOnce(
  result: FaultWorkerResult,
  expectedReply: string
): boolean {
  return (
    result.ok && result.commitCount === 1 && result.reply === expectedReply
  );
}

function describe(result: FaultWorkerResult): string {
  return [
    `ok=${result.ok}`,
    `status=${result.status ?? "unknown"}`,
    `commits=${result.commitCount ?? "unknown"}`,
    `elapsedMs=${result.elapsedMs}`,
  ].join(",");
}
