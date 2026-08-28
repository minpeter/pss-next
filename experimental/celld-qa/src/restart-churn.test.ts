import { describe, expect, it } from "vitest";
import { runRestartChurn } from "./restart-churn";

describe("restart churn", () => {
  it("restarts after every 250 completed requests until 5000 complete", async () => {
    const batches: number[] = [];
    const restartAt: number[] = [];

    const result = await runRestartChurn({
      restartEvery: 250,
      restart: (completed) => {
        restartAt.push(completed);
        return Promise.resolve();
      },
      runBatch: (requestCount) => {
        batches.push(requestCount);
        return Promise.resolve({
          cleanup: { drained: true, inFlight: 0 },
          completed: requestCount,
          correct: requestCount,
        });
      },
      totalRequests: 5000,
    });

    expect(batches).toEqual(Array.from({ length: 20 }, () => 250));
    expect(restartAt).toEqual(
      Array.from({ length: 19 }, (_, index) => (index + 1) * 250)
    );
    expect(result).toEqual({
      cleanup: { drained: true, inFlight: 0 },
      completed: 5000,
      correct: 5000,
      restarts: 19,
    });
  });

  it("stops before restart when a batch is incomplete", async () => {
    await expect(
      runRestartChurn({
        restartEvery: 250,
        restart: () => Promise.resolve(),
        runBatch: () =>
          Promise.resolve({
            cleanup: { drained: true, inFlight: 0 },
            completed: 249,
            correct: 249,
          }),
        totalRequests: 5000,
      })
    ).rejects.toThrow("completed 249 of 250");
  });

  it("rejects a batch that leaves requests in flight", async () => {
    await expect(
      runRestartChurn({
        restartEvery: 250,
        restart: () => Promise.resolve(),
        runBatch: () =>
          Promise.resolve({
            cleanup: { drained: false, inFlight: 1 },
            completed: 250,
            correct: 249,
          }),
        totalRequests: 5000,
      })
    ).rejects.toThrow("did not drain");
  });

  it("stops before restart when any completed request is incorrect", async () => {
    await expect(
      runRestartChurn({
        restartEvery: 250,
        restart: () => Promise.resolve(),
        runBatch: () =>
          Promise.resolve({
            cleanup: { drained: true, inFlight: 0 },
            completed: 250,
            correct: 249,
          }),
        totalRequests: 5000,
      })
    ).rejects.toThrow("249 of 250 requests were correct");
  });
});
