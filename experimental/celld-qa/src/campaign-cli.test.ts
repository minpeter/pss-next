import { afterEach, describe, expect, it, vi } from "vitest";
import { runCampaignCli } from "./campaign-cli";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("campaign CLI failure reporting", () => {
  it("reports the underlying cause alongside the failure sentinel", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      errors.push(String(value));
    });

    const exitCode = await runCampaignCli(["profiles", "--profiles", "restart"]);

    expect(exitCode).toBe(1);
    expect(errors[0]).toBe("CELLD_QA_CAMPAIGN_FAILED");
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("requiredStringOption");
  });

  it("rejects an unknown campaign command with a diagnosable cause", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      errors.push(String(value));
    });

    const exitCode = await runCampaignCli(["not-a-command"]);

    expect(exitCode).toBe(1);
    expect(errors[0]).toBe("CELLD_QA_CAMPAIGN_FAILED");
    expect(errors[1]).not.toBe("undefined");
  });
});
