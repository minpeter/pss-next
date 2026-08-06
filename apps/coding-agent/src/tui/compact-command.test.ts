import { describe, expect, it, vi } from "vitest";
import { createCompactCommand } from "./compact-command";

describe("/compact", () => {
  it("runs runtime-owned compaction", async () => {
    const compact = vi.fn(() => Promise.resolve(true));

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Session context compacted.",
      success: true,
    });
    expect(compact).toHaveBeenCalledWith(undefined);
  });

  it("passes custom summary instructions", async () => {
    const compact = vi.fn(() => Promise.resolve(true));

    await createCompactCommand({ compact }).execute({
      args: ["focus", "on", "decisions"],
    });

    expect(compact).toHaveBeenCalledWith("focus on decisions");
  });

  it("reports empty history without treating it as an error", async () => {
    const compact = vi.fn(() => Promise.resolve(false));

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Nothing to compact in the current session.",
      success: true,
    });
  });

  it("makes active-turn rejection explicit", async () => {
    const compact = vi.fn(() =>
      Promise.reject(new Error("Cannot compact while a turn is active."))
    );

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Compaction failed: Cannot compact while a turn is active.",
      success: false,
    });
  });
});
