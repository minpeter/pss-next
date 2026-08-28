import { describe, expect, it, vi } from "vitest";
import { runWithCampaignCleanup } from "./campaign-lifecycle";

describe("campaign lifecycle", () => {
  it("runs cleanup and preserves the primary error identity", async () => {
    const primary = new Error("operation failed");
    const cleanupFailure = new Error("cleanup failed");
    const cleanup = vi.fn(() => Promise.reject(cleanupFailure));

    const operation = runWithCampaignCleanup({
      cleanup,
      run: () => Promise.reject(primary),
    });

    await expect(operation).rejects.toBe(primary);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("surfaces cleanup failure after a successful operation", async () => {
    const cleanupFailure = new Error("cleanup failed");

    await expect(
      runWithCampaignCleanup({
        cleanup: () => Promise.reject(cleanupFailure),
        run: () => Promise.resolve("completed"),
      })
    ).rejects.toBe(cleanupFailure);
  });

  it("returns the operation value after successful cleanup", async () => {
    await expect(
      runWithCampaignCleanup({
        cleanup: () => Promise.resolve(),
        run: () => Promise.resolve("completed"),
      })
    ).resolves.toBe("completed");
  });
});
