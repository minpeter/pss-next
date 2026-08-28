import type { ProfilePlan, ProfileRequest } from "./profile-types";

export const PROFILE_PLANS = {
  hot: { concurrency: 64, kind: "hot", objectCount: 1, requestCount: 1000 },
  mixed: {
    coldObjectCount: 50,
    coldTrafficCount: 200,
    concurrency: 64,
    hotObjectCount: 50,
    hotTrafficCount: 800,
    kind: "mixed",
    objectCount: 100,
    requestCount: 1000,
  },
  restart: {
    concurrency: 64,
    kind: "restart",
    objectCount: 100,
    requestCount: 5000,
    restartEvery: 250,
  },
  soak: {
    admissionMs: 1_800_000,
    concurrency: 64,
    drainMs: 120_000,
    kind: "soak",
    objectCount: 100,
  },
  wide: {
    concurrency: 256,
    kind: "wide",
    objectCount: 1000,
    requestCount: 1000,
  },
} as const satisfies Record<string, ProfilePlan>;

export class InvalidRequestIndexError extends Error {
  readonly index: number;
  readonly name = "InvalidRequestIndexError";

  constructor(index: number) {
    super(`Request index is outside the profile plan: ${index}`);
    this.index = index;
  }
}

export function requestAt(plan: ProfilePlan, index: number): ProfileRequest {
  if (!Number.isInteger(index) || index < 0) {
    throw new InvalidRequestIndexError(index);
  }
  switch (plan.kind) {
    case "wide":
    case "hot":
    case "restart":
      if (index >= plan.requestCount) {
        throw new InvalidRequestIndexError(index);
      }
      return { index, objectName: objectName(index % plan.objectCount) };
    case "mixed": {
      if (index >= plan.requestCount) {
        throw new InvalidRequestIndexError(index);
      }
      const hotRequestsPerCycle = plan.hotTrafficCount / plan.coldTrafficCount;
      const cycleSize = hotRequestsPerCycle + 1;
      const cycle = Math.floor(index / cycleSize);
      const slot = index % cycleSize;
      const objectIndex =
        slot < hotRequestsPerCycle
          ? (cycle * hotRequestsPerCycle + slot) % plan.hotObjectCount
          : plan.hotObjectCount + (cycle % plan.coldObjectCount);
      return { index, objectName: objectName(objectIndex) };
    }
    case "soak":
      return { index, objectName: objectName(index % plan.objectCount) };
    default:
      return assertNever(plan);
  }
}

function objectName(index: number): string {
  return `profile-object-${index}`;
}

function assertNever(value: never): never {
  throw new InvalidRequestIndexError(Number(value));
}
