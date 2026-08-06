import { describe, expect, it, vi } from "vitest";
import { retryReleasedThreadDrain } from "./agent-thread-drain";

describe("released thread drain restart", () => {
  it("retries a transient restart failure without another notification", async () => {
    const drain = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValue(undefined);
    const permanentFailure = vi.fn();

    await retryReleasedThreadDrain(drain, permanentFailure);

    expect(drain).toHaveBeenCalledTimes(2);
    expect(permanentFailure).not.toHaveBeenCalled();
  });

  it("surfaces a permanent restart failure after bounded retries", async () => {
    const failure = new Error("refresh permanently failed");
    const drain = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const permanentFailure = vi.fn();

    await retryReleasedThreadDrain(drain, permanentFailure);

    expect(drain).toHaveBeenCalledTimes(3);
    expect(permanentFailure).toHaveBeenCalledWith(failure);
  });
});
