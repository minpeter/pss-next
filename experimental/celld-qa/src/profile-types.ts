export const PROFILE_NAMES = [
  "wide",
  "hot",
  "mixed",
  "restart",
  "soak",
] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface MonotonicClock {
  readonly now: () => number;
}

export interface ProfileRequest {
  readonly index: number;
  readonly objectName: string;
}

interface PlanBase {
  readonly concurrency: number;
  readonly objectCount: number;
}

export interface WidePlan extends PlanBase {
  readonly kind: "wide";
  readonly requestCount: number;
}

export interface HotPlan extends PlanBase {
  readonly kind: "hot";
  readonly requestCount: number;
}

export interface MixedPlan extends PlanBase {
  readonly coldObjectCount: number;
  readonly coldTrafficCount: number;
  readonly hotObjectCount: number;
  readonly hotTrafficCount: number;
  readonly kind: "mixed";
  readonly requestCount: number;
}

export interface RestartPlan extends PlanBase {
  readonly kind: "restart";
  readonly requestCount: number;
  readonly restartEvery: number;
}

export interface SoakPlan extends PlanBase {
  readonly admissionMs: number;
  readonly drainMs: number;
  readonly kind: "soak";
}

export type FiniteProfilePlan = WidePlan | HotPlan | MixedPlan | RestartPlan;
export type ProfilePlan = FiniteProfilePlan | SoakPlan;

export interface ProgressSnapshot {
  readonly admitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly inFlight: number;
}

export interface RequestObservation {
  readonly correct: boolean;
}

export type ProfileFetch = (
  request: ProfileRequest,
  signal: AbortSignal
) => Promise<RequestObservation>;
