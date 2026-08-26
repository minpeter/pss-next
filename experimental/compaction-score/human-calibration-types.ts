import type { ModelMessage } from "ai";

export const HUMAN_CALIBRATION_PROTOCOL = "human-calib-v2" as const;

export type HumanMatch = "equiv" | "exact" | "unknown" | "wrong";
export type ViewedArm = "A" | "B" | "source";
export type HmacSha256 = `hmac-sha256:${string}`;

export interface BlindedPacket {
  readonly content_digest: `sha256:${string}`;
  readonly messages: readonly ModelMessage[];
  readonly packet_id: `sha256:${string}`;
  readonly presentation: {
    readonly question_order: readonly string[];
  };
  readonly questions: readonly {
    readonly candidates?: Readonly<Record<"A" | "B", string>>;
    readonly category: string;
    readonly qid: string;
    readonly question: string;
  }[];
  readonly scenario: string;
  readonly schema_version: typeof HUMAN_CALIBRATION_PROTOCOL;
  readonly seed: string;
}

export interface CalibrationKey {
  readonly answer: string;
  readonly automatedMatches: Readonly<
    Partial<Record<"A" | "B" | "source", boolean>>
  >;
  readonly packet_id: string;
  readonly qid: string;
}

export interface ArmMappingEvidence {
  readonly mapping_hmac: HmacSha256;
  readonly packet_id: string;
  readonly qid: string;
}

export interface HumanCalibrationInputItem {
  readonly compactedAnswer?: string;
  readonly fullAnswer?: string;
  readonly messages: readonly ModelMessage[];
  readonly questions: readonly {
    readonly answer: string;
    readonly category: string;
    readonly question: string;
  }[];
  readonly scenario: string;
  readonly seed: string;
}

export interface HumanLabel {
  readonly annotatorId: string;
  readonly annotatorRole: "adjudicator" | "primary" | "secondary";
  readonly candidateMatch: HumanMatch;
  readonly confidence: number;
  readonly contentDigest: string;
  readonly difficulty: "easy" | "hard" | "med";
  readonly humanAnswer: string;
  readonly labeledAtUtc: string;
  readonly packetId: string;
  readonly protocolVersion: typeof HUMAN_CALIBRATION_PROTOCOL;
  readonly qid: string;
  readonly secondsSpent: number;
  readonly sessionId: string;
  readonly viewedArm: ViewedArm;
}

export interface HumanCalibrationReport {
  readonly annotatorIds: readonly string[];
  readonly calibrationByConfidence: readonly {
    readonly accuracy: number;
    readonly confidence: number;
    readonly count: number;
  }[];
  readonly confusion: {
    readonly falseNegative: number;
    readonly falsePositive: number;
    readonly trueNegative: number;
    readonly truePositive: number;
  };
  readonly createdAt: string;
  readonly humanFixtureAgreement: number;
  readonly humanFixtureWilson95: readonly [number, number];
  readonly interRaterKappa: number | null;
  readonly labelCount: number;
  readonly labeledAtUtcRange: readonly [string, string];
  readonly labelsContentDigest: string;
  readonly packetContentDigest: string;
  readonly protocolVersion: typeof HUMAN_CALIBRATION_PROTOCOL;
  readonly provenancePolicy: "declared-actual-human-no-automation";
  readonly schemaVersion: "human-calibration-v1";
  readonly semanticAgreement: number;
  readonly semanticWilson95: readonly [number, number];
  readonly sessionIds: readonly string[];
}
