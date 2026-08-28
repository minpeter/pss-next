import type { CleanupRemaining } from "./campaign-cleanup";
import type { JsonValue } from "./campaign-report";

export const scenarioNames = [
  "tool-checkpoint",
  "input-ordering",
  "compaction",
  "large-history",
  "attachment",
] as const;
export type ScenarioName = (typeof scenarioNames)[number];
export type ScenarioPhase = "resume" | "run" | "verify";

export interface RealAgentCampaignOptions {
  readonly port: number;
  readonly report: string;
}

export interface RealAgentCampaignDependencies<TChild = unknown> {
  readonly cleanupPrefix: (prefix: string) => Promise<void>;
  readonly createBucket: () => Promise<void>;
  readonly deploy: (prefix: string) => Promise<void>;
  readonly fetchScenario: (
    baseUrl: string,
    scenario: ScenarioName,
    phase: ScenarioPhase,
    token: string
  ) => Promise<Readonly<Record<string, JsonValue>>>;
  readonly interruptScenario: (
    baseUrl: string,
    scenario: ScenarioName,
    token: string
  ) => Promise<void>;
  readonly makeWatchDirectory: () => Promise<string>;
  readonly measureCleanup: (
    scope: RealAgentCleanupScope<TChild>
  ) => Promise<CleanupRemaining>;
  readonly removeWatchDirectory: (path: string) => Promise<void>;
  readonly restartCelld: (
    prefix: string,
    port: number,
    watch: string,
    child: TChild
  ) => Promise<TChild>;
  readonly startCelld: (prefix: string, port: number, watch: string) => TChild;
  readonly stopCelld: (child: TChild) => Promise<void>;
  readonly waitForListening: (child: TChild) => Promise<void>;
  readonly waitForProcessExit: (
    child: TChild,
    signal: AbortSignal
  ) => Promise<void>;
}

export interface RealAgentCleanupScope<TChild> {
  readonly children: readonly TChild[];
  readonly port: number;
  readonly prefix: string;
  readonly watch: string;
}
