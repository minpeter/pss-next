import { describe, expect, it } from "vitest";
import { createHarness } from "./command.test-harness";

describe("pss update --check", () => {
  it("describes the update without changing anything for --check", async () => {
    const harness = createHarness({ args: ["--check"] });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("0.0.13");
    expect(harness.output()).toContain("latest");
    expect(harness.output()).toContain("pnpm");
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
    expect(harness.spawns).toEqual([]);
  });

  it("stays put for --check when the installed version is ahead of its channel", async () => {
    const harness = createHarness({
      args: ["--check"],
      version: "0.0.15",
      tags: { latest: "0.0.14" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.output()).not.toContain("would run");
    expect(harness.spawns).toEqual([]);
  });

  it("previews an explicit channel switch even when it lowers the version", async () => {
    const harness = createHarness({
      args: ["--check", "--channel", "latest"],
      version: "0.0.15-next.0",
      tags: { latest: "0.0.14", next: "0.0.15-next.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("0.0.15-next.0 -> 0.0.14");
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
    expect(harness.spawns).toEqual([]);
  });

  it("still reports registry state for --check on a dev build", async () => {
    const harness = createHarness({ args: ["--check"], version: undefined });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("dev");
    expect(harness.output()).toContain("0.0.14");
    expect(harness.spawns).toEqual([]);
  });
});
