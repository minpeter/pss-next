import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseArmMappingEvidence,
  parseHumanCalibrationKey,
  parseHumanCalibrationPacket,
} from "./human-calibration-evidence-parse";
import { validateCalibrationPacketKeys } from "./human-calibration-key-validation";
import {
  deriveFullAnswerArm,
  resolveHumanCalibrationSecret,
  verifyArmMappingDigest,
} from "./human-calibration-sealing";
import {
  type ArmMappingEvidence,
  type BlindedPacket,
  type CalibrationKey,
  HUMAN_CALIBRATION_PROTOCOL,
  type HumanLabel,
  type ViewedArm,
} from "./human-calibration-types";
import {
  isRecord,
  normalizeCalibrationAnswer,
  sha256,
} from "./human-calibration-utils";

const LINE_BREAK_PATTERN = /\r?\n/;

export async function loadHumanCalibrationEvidence(
  packetDirectory: string,
  labels: readonly HumanLabel[],
  coordinatorSecret?: string
): Promise<{
  readonly contentDigest: string;
  readonly keyMap: ReadonlyMap<string, CalibrationKey>;
}> {
  const secret = resolveHumanCalibrationSecret(coordinatorSecret);
  const evidence = await validateHumanCalibrationPacket(
    packetDirectory,
    secret
  );
  validateLabels(labels, evidence.packetMap, evidence.keyMap);
  return {
    contentDigest: evidence.contentDigest,
    keyMap: evidence.keyMap,
  };
}

export async function validateHumanCalibrationPacket(
  packetDirectory: string,
  coordinatorSecret?: string
): Promise<{
  readonly contentDigest: string;
  readonly keyMap: ReadonlyMap<string, CalibrationKey>;
  readonly packetCount: number;
  readonly packetMap: ReadonlyMap<string, BlindedPacket>;
}> {
  const secret = resolveHumanCalibrationSecret(coordinatorSecret);
  const packetContents = await readFile(
    join(packetDirectory, "annotator", "packets.blinded.jsonl"),
    "utf8"
  );
  const packets = parseLines(packetContents).map(parseHumanCalibrationPacket);
  const keys = parseLines(
    await readFile(
      join(packetDirectory, "sealed", "packets.keys.jsonl"),
      "utf8"
    )
  ).map(parseHumanCalibrationKey);
  const mappingEvidence = parseLines(
    await readFile(
      join(packetDirectory, "sealed", "arm-mapping.hmac.jsonl"),
      "utf8"
    )
  ).map(parseArmMappingEvidence);
  const manifest: unknown = JSON.parse(
    await readFile(join(packetDirectory, "manifest.json"), "utf8")
  );
  const contentDigest = validateManifest(
    manifest,
    packetContents,
    packets.length
  );
  const packetMap = uniqueMap(
    packets.map((packet) => [packet.packet_id, packet] as const),
    "packet"
  );
  const keyMap = uniqueMap(
    keys.map((key) => [keyId(key), key] as const),
    "key"
  );
  const mappingMap = uniqueMap(
    mappingEvidence.map((evidence) => [keyId(evidence), evidence] as const),
    "arm mapping evidence"
  );
  validateCalibrationPacketKeys(packetMap, keyMap);
  validateArmMappingEvidence(packetMap, keyMap, mappingMap, secret);
  return {
    contentDigest,
    keyMap,
    packetCount: packets.length,
    packetMap,
  };
}

function validateManifest(
  value: unknown,
  packetContents: string,
  packetCount: number
): string {
  if (
    !isRecord(value) ||
    value.protocolVersion !== HUMAN_CALIBRATION_PROTOCOL ||
    value.packetCount !== packetCount ||
    value.contentDigest !== sha256(packetContents) ||
    value.annotatorDirectory !== "annotator" ||
    value.sealedArmMappingFile !== "sealed/arm-mapping.hmac.jsonl" ||
    value.sealedKeyFile !== "sealed/packets.keys.jsonl" ||
    "masterSeed" in value
  ) {
    throw new TypeError("Human calibration manifest is invalid.");
  }
  return value.contentDigest;
}

function validateArmMappingEvidence(
  packets: ReadonlyMap<string, BlindedPacket>,
  keys: ReadonlyMap<string, CalibrationKey>,
  evidence: ReadonlyMap<string, ArmMappingEvidence>,
  coordinatorSecret: string
): void {
  if (
    evidence.size !== keys.size ||
    [...evidence.keys()].some((identity) => !keys.has(identity))
  ) {
    throw new TypeError("Human calibration arm mapping evidence is invalid.");
  }
  for (const key of keys.values()) {
    const packet = packets.get(key.packet_id);
    const question = packet?.questions.find(
      (candidate) => candidate.qid === key.qid
    );
    const mapping: ViewedArm =
      question?.candidates === undefined
        ? "source"
        : deriveFullAnswerArm(coordinatorSecret, key.packet_id);
    const evidenceItem = evidence.get(keyId(key));
    if (
      evidenceItem === undefined ||
      !verifyArmMappingDigest(
        coordinatorSecret,
        {
          answer: key.answer,
          automatedMatches: key.automatedMatches,
          candidates: question?.candidates,
          mapping,
          packetId: key.packet_id,
          qid: key.qid,
        },
        evidenceItem.mapping_hmac
      )
    ) {
      throw new TypeError("Human calibration arm mapping evidence is invalid.");
    }
  }
}

function validateLabels(
  labels: readonly HumanLabel[],
  packets: ReadonlyMap<string, BlindedPacket>,
  keys: ReadonlyMap<string, CalibrationKey>
): void {
  const duplicates = new Set<string>();
  const covered = new Set<string>();
  for (const label of labels) {
    const id = labelId(label);
    const key = keys.get(id);
    const packet = packets.get(label.packetId);
    const question = packet?.questions.find(
      (candidate) => candidate.qid === label.qid
    );
    if (
      key === undefined ||
      packet === undefined ||
      question === undefined ||
      label.contentDigest !== packet.content_digest
    ) {
      throw new TypeError("Human label packet identity is invalid.");
    }
    const candidate =
      label.viewedArm === "source"
        ? undefined
        : question?.candidates?.[label.viewedArm];
    if (
      candidate !== undefined &&
      label.candidateMatch === "exact" &&
      normalizeCalibrationAnswer(candidate) !==
        normalizeCalibrationAnswer(label.humanAnswer)
    ) {
      throw new TypeError("Exact human candidate match is inconsistent.");
    }
    const expectedArms = expectedKeyArms(key);
    if (!expectedArms.includes(label.viewedArm)) {
      throw new TypeError("Human label viewed arm is invalid.");
    }
    const duplicate = `${label.annotatorId}:${label.sessionId}:${id}:${label.viewedArm}`;
    if (duplicates.has(duplicate)) {
      throw new TypeError("Duplicate human calibration label.");
    }
    duplicates.add(duplicate);
    covered.add(`${id}:${label.viewedArm}`);
  }
  for (const key of keys.values()) {
    for (const arm of expectedKeyArms(key)) {
      if (!covered.has(`${keyId(key)}:${arm}`)) {
        throw new TypeError("Human calibration labels are incomplete.");
      }
    }
  }
}

function expectedKeyArms(
  key: CalibrationKey
): readonly ("A" | "B" | "source")[] {
  const arms = (["A", "B", "source"] as const).filter(
    (arm) => key.automatedMatches[arm] !== undefined
  );
  return arms.length === 0 ? ["source"] : arms;
}

function uniqueMap<T>(
  entries: readonly (readonly [string, T])[],
  name: string
): ReadonlyMap<string, T> {
  const result = new Map(entries);
  if (result.size !== entries.length) {
    throw new TypeError(`Duplicate human calibration ${name}.`);
  }
  return result;
}

function parseLines(input: string): readonly unknown[] {
  return input
    .split(LINE_BREAK_PATTERN)
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
}

function labelId(label: HumanLabel): string {
  return `${label.packetId}:${label.qid}`;
}

function keyId(key: Pick<CalibrationKey, "packet_id" | "qid">): string {
  return `${key.packet_id}:${key.qid}`;
}
