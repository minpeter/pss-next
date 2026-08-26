import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHumanCalibrationInput } from "./human-calibration-input";
import {
  armMappingDigest,
  deriveFullAnswerArm,
  resolveHumanCalibrationSecret,
} from "./human-calibration-sealing";
import {
  HUMAN_CALIBRATION_INSTRUCTIONS,
  HUMAN_CALIBRATION_LABEL_HEADER,
  HUMAN_CALIBRATION_QUESTION_ORDER_SEED,
} from "./human-calibration-template";
import {
  type ArmMappingEvidence,
  type BlindedPacket,
  type CalibrationKey,
  HUMAN_CALIBRATION_PROTOCOL,
  type HumanCalibrationInputItem,
} from "./human-calibration-types";
import {
  jsonLines,
  normalizeCalibrationAnswer,
  seededCalibrationRandom,
  sha256,
  shuffleWith,
  stableStringify,
} from "./human-calibration-utils";

export async function exportHumanCalibration({
  coordinatorSecret,
  inputPath,
  outputDirectory,
}: {
  readonly coordinatorSecret?: string;
  readonly inputPath: string;
  readonly outputDirectory: string;
}): Promise<{
  readonly contentDigest: string;
  readonly packetCount: number;
}> {
  const secret = resolveHumanCalibrationSecret(coordinatorSecret);
  const input = parseHumanCalibrationInput(
    JSON.parse(await readFile(inputPath, "utf8"))
  );
  const packets: BlindedPacket[] = [];
  const keys: CalibrationKey[] = [];
  const mappingEvidence: ArmMappingEvidence[] = [];
  const templateRows = [HUMAN_CALIBRATION_LABEL_HEADER];

  for (const item of input) {
    const exported = exportItem(item, secret);
    packets.push(exported.packet);
    keys.push(...exported.keys);
    mappingEvidence.push(...exported.mappingEvidence);
    for (const key of exported.keys) {
      const arms = Object.keys(key.automatedMatches);
      for (const arm of arms.length === 0 ? ["source"] : arms) {
        templateRows.push(
          [
            key.packet_id,
            exported.packet.content_digest,
            key.qid,
            "",
            "",
            "",
            "",
            arm,
            "",
            "",
            "",
            "",
            "",
            "",
            HUMAN_CALIBRATION_PROTOCOL,
          ].join(",")
        );
      }
    }
  }

  const packetJsonl = jsonLines(packets);
  const keyJsonl = jsonLines(keys);
  const mappingJsonl = jsonLines(mappingEvidence);
  const contentDigest = sha256(packetJsonl);
  const annotatorDirectory = join(outputDirectory, "annotator");
  const sealedDirectory = join(outputDirectory, "sealed");
  await Promise.all([
    mkdir(annotatorDirectory, { recursive: true }),
    mkdir(sealedDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(annotatorDirectory, "packets.blinded.jsonl"), packetJsonl),
    writeFile(join(sealedDirectory, "packets.keys.jsonl"), keyJsonl),
    writeFile(join(sealedDirectory, "arm-mapping.hmac.jsonl"), mappingJsonl),
    writeFile(
      join(annotatorDirectory, "labels-template.csv"),
      templateRows.join("\n")
    ),
    writeFile(
      join(annotatorDirectory, "README.md"),
      HUMAN_CALIBRATION_INSTRUCTIONS
    ),
    writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(
        {
          contentDigest,
          annotatorDirectory: "annotator",
          instructionsFile: "annotator/README.md",
          packetCount: packets.length,
          protocolVersion: HUMAN_CALIBRATION_PROTOCOL,
          sealedArmMappingFile: "sealed/arm-mapping.hmac.jsonl",
          sealedKeyFile: "sealed/packets.keys.jsonl",
        },
        null,
        2
      )}\n`
    ),
  ]);
  return { contentDigest, packetCount: packets.length };
}

function exportItem(
  item: HumanCalibrationInputItem,
  coordinatorSecret: string
): {
  readonly keys: readonly CalibrationKey[];
  readonly mappingEvidence: readonly ArmMappingEvidence[];
  readonly packet: BlindedPacket;
} {
  const identity = {
    candidates: [item.compactedAnswer, item.fullAnswer]
      .filter((candidate): candidate is string => candidate !== undefined)
      .sort((left, right) => left.localeCompare(right)),
    messages: item.messages,
    questions: item.questions.map(({ category, question }) => ({
      category,
      question,
    })),
    scenario: item.scenario,
    seed: item.seed,
  };
  const packetId = sha256(stableStringify(identity));
  const fullAnswerArm = deriveFullAnswerArm(coordinatorSecret, packetId);
  const displayed = displayedCandidates(item, fullAnswerArm);
  const random = seededCalibrationRandom(
    sha256(`${HUMAN_CALIBRATION_QUESTION_ORDER_SEED}:${packetId}`)
  );
  const questions = item.questions.map((question, index) => ({
    ...(displayed === null ? {} : { candidates: displayed }),
    category: question.category,
    qid: `q${index}`,
    question: question.question,
  }));
  const questionOrder = shuffleWith(
    questions.map(({ qid }) => qid),
    random
  );
  const packetWithoutDigest = {
    messages: item.messages,
    packet_id: packetId,
    presentation: {
      question_order: questionOrder,
    },
    questions,
    scenario: item.scenario,
    schema_version: HUMAN_CALIBRATION_PROTOCOL,
    seed: item.seed,
  } as const;
  return {
    keys: item.questions.map((question, index) => ({
      answer: question.answer,
      automatedMatches: automatedMatches(displayed, question.answer),
      packet_id: packetId,
      qid: `q${index}`,
    })),
    mappingEvidence: item.questions.map((question, index) => ({
      mapping_hmac: armMappingDigest(coordinatorSecret, {
        answer: question.answer,
        automatedMatches: automatedMatches(displayed, question.answer),
        candidates: displayed ?? undefined,
        mapping: displayed === null ? "source" : fullAnswerArm,
        packetId,
        qid: `q${index}`,
      }),
      packet_id: packetId,
      qid: `q${index}`,
    })),
    packet: {
      ...packetWithoutDigest,
      content_digest: sha256(stableStringify(packetWithoutDigest)),
    },
  };
}

function displayedCandidates(
  item: HumanCalibrationInputItem,
  fullAnswerArm: "A" | "B"
): Readonly<Record<"A" | "B", string>> | null {
  if (item.fullAnswer === undefined || item.compactedAnswer === undefined) {
    return null;
  }
  return fullAnswerArm === "A"
    ? { A: item.fullAnswer, B: item.compactedAnswer }
    : { A: item.compactedAnswer, B: item.fullAnswer };
}

function automatedMatches(
  candidates: Readonly<Record<"A" | "B", string>> | null,
  answer: string
): CalibrationKey["automatedMatches"] {
  return candidates === null
    ? {}
    : {
        A:
          normalizeCalibrationAnswer(candidates.A) ===
          normalizeCalibrationAnswer(answer),
        B:
          normalizeCalibrationAnswer(candidates.B) ===
          normalizeCalibrationAnswer(answer),
      };
}
