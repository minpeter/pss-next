import { modelMessageSchema } from "ai";
import type { HumanCalibrationInputItem } from "./human-calibration-types";
import { isRecord } from "./human-calibration-utils";

export function parseHumanCalibrationInput(
  value: unknown
): readonly HumanCalibrationInputItem[] {
  if (!(isRecord(value) && Array.isArray(value.calibrationItems))) {
    throw new TypeError("Human calibration input lacks calibrationItems.");
  }
  return value.calibrationItems.map(parseInputItem);
}

function parseInputItem(value: unknown): HumanCalibrationInputItem {
  if (
    !(
      isRecord(value) &&
      Array.isArray(value.messages) &&
      Array.isArray(value.questions) &&
      typeof value.scenario === "string" &&
      typeof value.seed === "string"
    )
  ) {
    throw new TypeError("Invalid human calibration input item.");
  }
  const messages = modelMessageSchema.array().safeParse(value.messages);
  if (!messages.success) {
    throw new TypeError("Invalid human calibration input item.");
  }
  return {
    ...(typeof value.compactedAnswer === "string"
      ? { compactedAnswer: value.compactedAnswer }
      : {}),
    ...(typeof value.fullAnswer === "string"
      ? { fullAnswer: value.fullAnswer }
      : {}),
    messages: messages.data,
    questions: value.questions.map(parseQuestion),
    scenario: value.scenario,
    seed: value.seed,
  };
}

function parseQuestion(
  value: unknown
): HumanCalibrationInputItem["questions"][number] {
  if (
    !isRecord(value) ||
    typeof value.answer !== "string" ||
    typeof value.category !== "string" ||
    typeof value.question !== "string"
  ) {
    throw new TypeError("Invalid human calibration question.");
  }
  return {
    answer: value.answer,
    category: value.category,
    question: value.question,
  };
}
