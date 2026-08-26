import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type CalibrationKey,
  type HmacSha256,
  HUMAN_CALIBRATION_PROTOCOL,
  type ViewedArm,
} from "./human-calibration-types";

export const HUMAN_CALIBRATION_SECRET_ENV = "HUMAN_CALIBRATION_SECRET" as const;

const HMAC_PREFIX = "hmac-sha256:";
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAPPING_LABELS: Record<ViewedArm, string> = {
  A: "full:A;compacted:B",
  B: "full:B;compacted:A",
  source: "source",
};

export function resolveHumanCalibrationSecret(
  coordinatorSecret?: string
): string {
  const secret = coordinatorSecret ?? process.env[HUMAN_CALIBRATION_SECRET_ENV];
  if (secret === undefined || secret.trim().length === 0) {
    throw new TypeError("Human calibration coordinator secret is required.");
  }
  return secret;
}

export function deriveFullAnswerArm(
  coordinatorSecret: string,
  packetId: string
): Exclude<ViewedArm, "source"> {
  const digest = createHmac("sha256", coordinatorSecret)
    .update(
      `${HUMAN_CALIBRATION_PROTOCOL}\u0000arm-order\u0000${packetId}`,
      "utf8"
    )
    .digest();
  return digest.readUInt8(0) % 2 === 0 ? "A" : "B";
}

interface ArmMappingIdentity {
  readonly answer: string;
  readonly automatedMatches: CalibrationKey["automatedMatches"];
  readonly candidates: Readonly<Record<"A" | "B", string>> | undefined;
  readonly mapping: ViewedArm;
  readonly packetId: string;
  readonly qid: string;
}

export function armMappingDigest(
  coordinatorSecret: string,
  identity: ArmMappingIdentity
): HmacSha256 {
  return hmacSha256(
    coordinatorSecret,
    JSON.stringify({
      answer: identity.answer,
      automatedMatches: {
        A: identity.automatedMatches.A ?? null,
        B: identity.automatedMatches.B ?? null,
      },
      candidates: {
        A: identity.candidates?.A ?? null,
        B: identity.candidates?.B ?? null,
      },
      kind: "arm-mapping",
      mapping: MAPPING_LABELS[identity.mapping],
      packetId: identity.packetId,
      protocol: HUMAN_CALIBRATION_PROTOCOL,
      qid: identity.qid,
    })
  );
}

export function verifyArmMappingDigest(
  coordinatorSecret: string,
  identity: ArmMappingIdentity,
  suppliedDigest: unknown
): boolean {
  if (!isHmacSha256(suppliedDigest)) {
    return false;
  }
  const expected = Buffer.from(
    armMappingDigest(coordinatorSecret, identity).slice(HMAC_PREFIX.length),
    "hex"
  );
  const supplied = Buffer.from(suppliedDigest.slice(HMAC_PREFIX.length), "hex");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function isHmacSha256(value: unknown): value is HmacSha256 {
  return (
    typeof value === "string" &&
    value.startsWith(HMAC_PREFIX) &&
    HEX_DIGEST_PATTERN.test(value.slice(HMAC_PREFIX.length))
  );
}

function hmacSha256(value: string, message: string): HmacSha256 {
  return `${HMAC_PREFIX}${createHmac("sha256", value)
    .update(message, "utf8")
    .digest("hex")}`;
}
