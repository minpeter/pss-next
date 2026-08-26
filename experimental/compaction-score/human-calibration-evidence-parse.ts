import { modelMessageSchema } from "ai";
import { isHmacSha256 } from "./human-calibration-sealing";
import {
  type ArmMappingEvidence,
  type BlindedPacket,
  type CalibrationKey,
  HUMAN_CALIBRATION_PROTOCOL,
} from "./human-calibration-types";
import { isRecord, sha256, stableStringify } from "./human-calibration-utils";

export function parseHumanCalibrationPacket(value: unknown): BlindedPacket {
  if (!isBlindedPacket(value)) {
    throw new TypeError("Invalid blinded calibration packet.");
  }
  const { content_digest: digest, ...withoutDigest } = value;
  if (sha256(stableStringify(withoutDigest)) !== digest) {
    throw new TypeError("Blinded calibration packet digest mismatch.");
  }
  return value;
}

export function parseHumanCalibrationKey(value: unknown): CalibrationKey {
  if (
    !isRecord(value) ||
    typeof value.answer !== "string" ||
    !isRecord(value.automatedMatches) ||
    typeof value.packet_id !== "string" ||
    typeof value.qid !== "string"
  ) {
    throw new TypeError("Invalid human calibration key.");
  }
  if (!isAutomatedMatches(value.automatedMatches)) {
    throw new TypeError("Invalid automated calibration match.");
  }
  return {
    answer: value.answer,
    automatedMatches: value.automatedMatches,
    packet_id: value.packet_id,
    qid: value.qid,
  };
}

export function parseArmMappingEvidence(value: unknown): ArmMappingEvidence {
  if (
    !(
      isRecord(value) &&
      isHmacSha256(value.mapping_hmac) &&
      isSha256(value.packet_id)
    ) ||
    typeof value.qid !== "string"
  ) {
    throw new TypeError("Invalid human calibration arm mapping evidence.");
  }
  return {
    mapping_hmac: value.mapping_hmac,
    packet_id: value.packet_id,
    qid: value.qid,
  };
}

export function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && value.startsWith("sha256:");
}

function isBlindedPacket(value: unknown): value is BlindedPacket {
  return (
    isRecord(value) &&
    isSha256(value.content_digest) &&
    isSha256(value.packet_id) &&
    value.schema_version === HUMAN_CALIBRATION_PROTOCOL &&
    modelMessageSchema.array().safeParse(value.messages).success &&
    isRecord(value.presentation) &&
    Array.isArray(value.presentation.question_order) &&
    value.presentation.question_order.every(
      (item) => typeof item === "string"
    ) &&
    !("arm_order" in value.presentation) &&
    !("rng_seed" in value.presentation) &&
    Array.isArray(value.questions) &&
    value.questions.every(
      (question) =>
        isRecord(question) &&
        !("answer" in question) &&
        typeof question.category === "string" &&
        typeof question.qid === "string" &&
        typeof question.question === "string" &&
        (question.candidates === undefined ||
          (isRecord(question.candidates) &&
            Object.keys(question.candidates).length === 2 &&
            typeof question.candidates.A === "string" &&
            typeof question.candidates.B === "string"))
    ) &&
    typeof value.scenario === "string" &&
    typeof value.seed === "string"
  );
}

function isAutomatedMatches(
  value: Record<string, unknown>
): value is Record<string, unknown> & CalibrationKey["automatedMatches"] {
  return Object.entries(value).every(
    ([arm, match]) =>
      (arm === "A" || arm === "B" || arm === "source") &&
      typeof match === "boolean"
  );
}
