import {
  runRuntimeBlockControl,
  runRuntimeBlockTreatment,
} from "./runtime-block-time-arm-runner";
import type {
  RuntimeBlockObservation,
  RuntimeBlockTrialOptions,
} from "./runtime-block-time-types";

export type { RuntimeBlockTrialOptions } from "./runtime-block-time-types";

export async function runRuntimeBlockTrial(
  options: RuntimeBlockTrialOptions
): Promise<RuntimeBlockObservation> {
  options.abortSignal?.throwIfAborted();
  const now = options.now ?? performance.now.bind(performance);
  const treatmentFirst = options.repetition % 2 === 1;
  const treatment = treatmentFirst
    ? await runRuntimeBlockTreatment(options, now)
    : undefined;
  const control = await runRuntimeBlockControl(options, now);
  const resolvedTreatment =
    treatment ?? (await runRuntimeBlockTreatment(options, now));
  return {
    candidateApplied: resolvedTreatment.candidateApplied,
    controlFirstVisibleAtMs: control.firstVisibleAtMs,
    controlProviderStartedAtMs: control.providerStartedAtMs,
    controlSentAtMs: control.sentAtMs,
    controlStepStartedAtMs: control.stepStartedAtMs,
    controlTurnEndedAtMs: control.turnEndedAtMs,
    controlTurnStartedAtMs: control.turnStartedAtMs,
    pairOrder: treatmentFirst ? "treatment-control" : "control-treatment",
    pathValid: true,
    repetition: options.repetition,
    scenario: options.scenario,
    summarySpans: resolvedTreatment.summarySpans,
    targetFirstVisibleAtMs: resolvedTreatment.target.firstVisibleAtMs,
    targetProviderStartedAtMs: resolvedTreatment.target.providerStartedAtMs,
    targetSentAtMs: resolvedTreatment.target.sentAtMs,
    targetStepStartedAtMs: resolvedTreatment.target.stepStartedAtMs,
    targetTurnEndedAtMs: resolvedTreatment.target.turnEndedAtMs,
    targetTurnStartedAtMs: resolvedTreatment.target.turnStartedAtMs,
  };
}
