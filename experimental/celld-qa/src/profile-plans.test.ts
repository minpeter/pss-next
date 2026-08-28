import { describe, expect, it } from "vitest";
import { PROFILE_PLANS, requestAt } from "./profile-plans";

describe("profile request plans", () => {
  it("defines the exact wide and hot profiles", () => {
    expect(PROFILE_PLANS.wide).toMatchObject({
      concurrency: 256,
      objectCount: 1000,
      requestCount: 1000,
    });
    expect(PROFILE_PLANS.hot).toMatchObject({
      concurrency: 64,
      objectCount: 1,
      requestCount: 1000,
    });
    expect(
      new Set(
        Array.from(
          { length: 1000 },
          (_, index) => requestAt(PROFILE_PLANS.hot, index).objectName
        )
      )
    ).toEqual(new Set(["profile-object-0"]));
  });

  it("generates exact mixed 80/20 traffic with hot objects receiving 4x cold traffic", () => {
    const plan = PROFILE_PLANS.mixed;
    const counts = new Map<string, number>();
    for (let index = 0; index < plan.requestCount; index += 1) {
      const name = requestAt(plan, index).objectName;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const hotRequests = [...counts.entries()]
      .filter(([name]) => Number(name.split("-").at(-1)) < 50)
      .reduce((sum, [, count]) => sum + count, 0);
    const coldRequests = plan.requestCount - hotRequests;
    expect({ coldRequests, hotRequests, objects: counts.size }).toEqual({
      coldRequests: 200,
      hotRequests: 800,
      objects: 100,
    });
    expect(counts.get("profile-object-0")).toBe(16);
    expect(counts.get("profile-object-50")).toBe(4);
    expect(
      Array.from({ length: 5 }, (_, index) =>
        requestAt(plan, index).objectName.startsWith("profile-object-5")
          ? "cold"
          : "hot"
      )
    ).toEqual(["hot", "hot", "hot", "hot", "cold"]);
  });

  it("defines restart churn and bounded soak exactly", () => {
    expect(PROFILE_PLANS.restart).toMatchObject({
      requestCount: 5000,
      restartEvery: 250,
    });
    expect(PROFILE_PLANS.soak).toMatchObject({
      admissionMs: 1_800_000,
      drainMs: 120_000,
    });
  });

  it("rejects request indices outside finite plans", () => {
    expect(() => requestAt(PROFILE_PLANS.wide, 1000)).toThrow();
  });
});
