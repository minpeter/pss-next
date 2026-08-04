import type { PrepareModelStep } from "@minpeter/pss-runtime";

/**
 * createAgent has no stopWhen/stepCountIs. Cap tool-using steps by clearing
 * activeTools on the final allowed step so the model must finish in text.
 */
export const createStepCap = (maxSteps: number): PrepareModelStep => {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error("maxSteps must be a positive integer");
  }
  return ({ runtimeStepIndex }) => {
    if (runtimeStepIndex >= maxSteps - 1) {
      return { activeTools: [] };
    }
    return {};
  };
};
