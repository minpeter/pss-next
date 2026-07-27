import { describe, expect, it } from "vitest";
import { createHarness } from "./command.test-harness";

describe("pss update installation and refusal", () => {
  it("updates through the detected manager with an exact pinned version", async () => {
    const harness = createHarness({});

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14"],
      },
    ]);
    expect(harness.output()).toContain("0.0.13");
    expect(harness.output()).toContain("0.0.14");
    expect(harness.output()).toContain("Restart pss");
  });

  it("routes installs through cmd.exe on Windows", async () => {
    const harness = createHarness({ platform: "win32" });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          "pnpm",
          "add",
          "-g",
          "@minpeter/pss-coding-agent@0.0.14",
        ],
      },
    ]);
  });

  it("reports already up to date without spawning", async () => {
    const harness = createHarness({ tags: { latest: "0.0.13" } });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.spawns).toEqual([]);
  });

  it("stays put when the installed version is ahead of its channel tag", async () => {
    const harness = createHarness({
      version: "0.0.15",
      tags: { latest: "0.0.14" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.spawns).toEqual([]);
  });

  it("refuses a dev build without a baked version", async () => {
    const harness = createHarness({ version: undefined });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("global");
    expect(harness.spawns).toEqual([]);
  });

  it("refuses an ephemeral dlx or npx install", async () => {
    const harness = createHarness({
      method: { kind: "ephemeral", runner: "npx" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("npx");
    expect(harness.output()).toContain("pnpm add -g");
    expect(harness.spawns).toEqual([]);
  });

  it("prints manual instructions when the install method is unknown", async () => {
    const harness = createHarness({ method: { kind: "unknown" } });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("pnpm add -g");
    expect(harness.output()).toContain("npm install -g");
    expect(harness.spawns).toEqual([]);
  });

  it("fails when the registry cannot provide the target channel", async () => {
    const harness = createHarness({ tags: {} });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.spawns).toEqual([]);
  });

  it("propagates the installer exit code and prints the manual command", async () => {
    const harness = createHarness({ spawnExitCode: 3 });

    const exitCode = await harness.run();

    expect(exitCode).toBe(3);
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
  });

  it.each([[[]], [["--check"]]] as const)(
    "rejects an invalid embedded version for args %j",
    async (args) => {
      const harness = createHarness({ args, version: "not-semver" });

      const exitCode = await harness.run();

      expect(exitCode).toBe(1);
      expect(harness.output()).toContain("invalid embedded version");
      expect(harness.spawns).toEqual([]);
    }
  );

  it("rejects unknown arguments", async () => {
    const harness = createHarness({ args: ["--bogus"] });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("pss update");
    expect(harness.spawns).toEqual([]);
  });

  it("rejects repeated channel flags instead of taking the last value", async () => {
    const harness = createHarness({
      args: ["--channel", "beta", "--channel", "next"],
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("pss update");
    expect(harness.spawns).toEqual([]);
  });
});
