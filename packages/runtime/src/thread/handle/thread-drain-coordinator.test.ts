import { describe, expect, it, vi } from "vitest";
import { createInMemoryHost } from "../../platform/memory";
import { retryReleasedThreadDrain } from "./agent-thread-drain";
import { withThreadDrainOwnership } from "./thread-drain-coordinator";

describe("thread drain ownership refresh tracking", () => {
  it("keeps refresh required when a new owner's operation fails", async () => {
    const host = createInMemoryHost();
    const firstOwner = {};
    const secondOwner = {};
    const observed: boolean[] = [];
    await withThreadDrainOwnership(
      host,
      "refresh-retry",
      firstOwner,
      async ({ refreshRequired }) => {
        await Promise.resolve();
        observed.push(refreshRequired);
      }
    );
    await expect(
      withThreadDrainOwnership(
        host,
        "refresh-retry",
        secondOwner,
        async ({ refreshRequired }) => {
          await Promise.resolve();
          observed.push(refreshRequired);
          throw new Error("refresh failed");
        }
      )
    ).rejects.toThrow("refresh failed");
    await withThreadDrainOwnership(
      host,
      "refresh-retry",
      secondOwner,
      async ({ refreshRequired }) => {
        await Promise.resolve();
        observed.push(refreshRequired);
      }
    );
    await withThreadDrainOwnership(
      host,
      "refresh-retry",
      secondOwner,
      async ({ refreshRequired }) => {
        await Promise.resolve();
        observed.push(refreshRequired);
      }
    );

    expect(observed).toEqual([false, true, true, false]);
  });

  it("preserves refresh-required state through all permanent restart retries", async () => {
    const host = createInMemoryHost();
    await withThreadDrainOwnership(
      host,
      "permanent",
      {},
      async () => undefined
    );
    const owner = {};
    const refreshValues: boolean[] = [];
    const permanentFailure = vi.fn();

    await retryReleasedThreadDrain(
      () =>
        withThreadDrainOwnership(
          host,
          "permanent",
          owner,
          async ({ refreshRequired }) => {
            await Promise.resolve();
            refreshValues.push(refreshRequired);
            throw new Error("refresh permanently failed");
          }
        ),
      permanentFailure
    );

    expect(refreshValues).toEqual([true, true, true]);
    expect(permanentFailure).toHaveBeenCalledOnce();
  });
});
