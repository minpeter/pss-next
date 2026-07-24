export const STABILITY_GATE_POLICY = {
  maximumAggregateMeanRatioDelta: 0.05,
  maximumProviderEvaluatorInvalidRate: 0.25,
  maximumScenarioMeanRatioDelta: 0.1,
  requiredRecall: 1,
  requiredRatioUpperBound: 1,
} as const;
