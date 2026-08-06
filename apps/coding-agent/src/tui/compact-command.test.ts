import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createCompactCommand } from "./compact-command";

describe("/compact", () => {
  it("runs runtime-owned compaction", async () => {
    const compact = vi.fn(() =>
      Promise.resolve({ status: "compacted" as const })
    );

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Session context compacted.",
      success: true,
    });
    expect(compact).toHaveBeenCalledWith(undefined);
  });

  it("passes custom summary instructions", async () => {
    const compact = vi.fn(() =>
      Promise.resolve({ status: "compacted" as const })
    );

    await createCompactCommand({ compact }).execute({
      args: ["focus", "on", "decisions"],
    });

    expect(compact).toHaveBeenCalledWith("focus on decisions");
  });

  it("reports empty history without treating it as an error", async () => {
    const compact = vi.fn(() => Promise.resolve({ status: "empty" as const }));

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message: "Nothing to compact in the current session.",
      success: true,
    });
  });

  it("distinguishes hook/freshness skips from empty history", async () => {
    const compact = vi.fn(() =>
      Promise.resolve({ status: "skipped" as const })
    );

    await expect(
      createCompactCommand({ compact }).execute({ args: [] })
    ).resolves.toEqual({
      message:
        "Compaction was skipped because a hook rejected it or the session changed.",
      success: false,
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

  it("normalizes provider failures without exposing raw provider details", async () => {
    const compact = vi.fn(() =>
      Promise.reject(
        new APICallError({
          isRetryable: false,
          message: "provider leaked secret-token",
          requestBodyValues: { apiKey: "request-secret" },
          statusCode: 429,
          url: "https://provider.example?token=url-secret",
        })
      )
    );

    const result = await createCompactCommand({ compact }).execute({
      args: [],
    });

    expect(result).toEqual({
      message:
        "Compaction failed: The provider rate limit was reached. Wait before retrying or check your provider quota.",
      success: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
