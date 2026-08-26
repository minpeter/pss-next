import type { LanguageModel } from "ai";

export class AttemptWallTimeoutError extends Error {}

export function requireRuntimeDeadlineModel(
  model: LanguageModel | undefined
): Exclude<LanguageModel, string> {
  if (model === undefined || typeof model === "string") {
    throw new TypeError("Runtime deadline benchmark requires a model object.");
  }
  return model;
}
