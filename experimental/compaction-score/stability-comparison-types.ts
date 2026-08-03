import type { BenchmarkScenario } from "./fixture";
import type {
  DisagreementFingerprint,
  Distribution,
  InvalidTrialStatus,
  TrialSummary,
} from "./report";

export type ReportRole = "baseline" | "candidate";

export type ReportFactIssue =
  | {
      readonly actual: string;
      readonly expected: string;
      readonly kind: "invalid";
      readonly path: string;
      readonly report: ReportRole;
    }
  | {
      readonly kind: "missing";
      readonly path: string;
      readonly report: ReportRole;
    }
  | {
      readonly kind: "unknown-scenario";
      readonly path: string;
      readonly report: ReportRole;
      readonly scenario: string;
    };

export type TrialSummaryInspection =
  | { readonly issue: ReportFactIssue; readonly valid: false }
  | { readonly summary: TrialSummary; readonly valid: true };

export interface RecallFacts {
  readonly accuracy: number;
  readonly correct: number;
  readonly id?: string;
  readonly total: number;
}

export interface StabilityReportFacts {
  readonly compression: {
    readonly aggregate: Distribution;
    readonly byHop: readonly {
      readonly hop: number;
      readonly ratio: Distribution;
    }[];
    readonly byScenario: readonly {
      readonly ratio: Distribution;
      readonly scenario: BenchmarkScenario;
    }[];
    readonly savings: Distribution;
  } | null;
  readonly invalidAttempts: {
    readonly attempted: number;
    readonly blocking: {
      readonly compactionPrompt: number;
      readonly nonCompressing: number;
      readonly protocol: number;
    };
    readonly byStatus: Readonly<Partial<Record<InvalidTrialStatus, number>>>;
    readonly providerEvaluator: {
      readonly count: number;
      readonly rate: number | null;
    };
    readonly valid: number;
  };
  readonly retention: {
    readonly aggregate: RecallFacts;
    readonly byCategory: readonly RecallFacts[];
    readonly byScenario: readonly (RecallFacts & {
      readonly id: BenchmarkScenario;
    })[];
    readonly disagreements: readonly DisagreementFingerprint[];
    readonly trialAccuracy: Distribution;
  } | null;
}

export interface StabilityComparisonFacts {
  readonly baseline: StabilityReportFacts;
  readonly candidate: StabilityReportFacts;
  readonly compressionDelta: {
    readonly aggregateMean: number | null;
    readonly byScenario: readonly {
      readonly baseline: number;
      readonly candidate: number;
      readonly delta: number;
      readonly scenario: BenchmarkScenario;
    }[];
  };
  readonly disagreementDrift: readonly DisagreementFingerprint[];
}
