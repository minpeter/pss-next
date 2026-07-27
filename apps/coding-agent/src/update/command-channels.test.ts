import { describe, expect, it } from "vitest";
import { createHarness } from "./command.test-harness";

describe("pss update channel transitions", () => {
  it("keeps a next-channel install on the next channel by default", async () => {
    const harness = createHarness({
      version: "0.0.14-next.1",
      tags: { latest: "0.0.13", next: "0.0.14-next.2" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14-next.2"],
      },
    ]);
  });

  it("uses latest by default for numeric prerelease identifiers", async () => {
    const harness = createHarness({
      version: "1.0.0-0",
      tags: { latest: "1.0.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@1.0.0"],
      },
    ]);
  });

  it.each(["1.4", "v1.4"])(
    "rejects semver-like channel name %s",
    async (channel) => {
      const harness = createHarness({
        args: ["--channel", channel],
        version: "1.0.0-next.1",
        tags: { [channel]: "1.0.0" },
      });

      const exitCode = await harness.run();

      expect(exitCode).toBe(1);
      expect(harness.output()).toContain("pss update");
      expect(harness.spawns).toEqual([]);
    }
  );

  it("moves a next-channel install to stable when --channel latest is explicit", async () => {
    const harness = createHarness({
      args: ["--channel", "latest"],
      version: "0.0.14-next.2",
      tags: { latest: "0.0.14", next: "0.0.14-next.2" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14"],
      },
    ]);
  });

  it("tracks an arbitrary prerelease channel by default", async () => {
    const harness = createHarness({
      version: "1.0.0-beta.1",
      tags: { beta: "1.0.0-beta.3", latest: "1.0.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@1.0.0-beta.3"],
      },
    ]);
  });

  it("allows an explicit move between prerelease channels", async () => {
    const harness = createHarness({
      args: ["--channel", "canary"],
      version: "1.0.0-beta.1",
      tags: { beta: "1.0.0-beta.3", canary: "1.0.0-canary.2", latest: "1.0.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@1.0.0-canary.2"],
      },
    ]);
  });

  it("refuses to move a stable install to any prerelease channel", async () => {
    const harness = createHarness({
      args: ["--channel", "canary"],
      version: "1.0.0",
      tags: { latest: "1.0.0", canary: "1.0.1-canary.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("keeps stable installs");
    expect(harness.spawns).toEqual([]);
  });

  it("treats prototype property names as unpublished channels", async () => {
    const harness = createHarness({
      args: ["--channel", "toString"],
      version: "1.0.0-beta.1",
      tags: { latest: "1.0.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("not published");
    expect(harness.spawns).toEqual([]);
  });

  it("reports published channels when the requested one is missing", async () => {
    const harness = createHarness({
      args: ["--channel", "canary"],
      version: "1.0.0-beta.1",
      tags: { beta: "1.0.0-beta.2", latest: "1.0.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("canary");
    expect(harness.output()).toContain("beta");
    expect(harness.output()).toContain("latest");
    expect(harness.spawns).toEqual([]);
  });

  it("does not downgrade an explicitly repeated active channel", async () => {
    const harness = createHarness({
      args: ["--channel", "latest"],
      version: "1.2.0",
      tags: { latest: "1.1.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.output()).toContain("up to date");
    expect(harness.spawns).toEqual([]);
  });

  it("rejects a stable install switching to the next channel", async () => {
    const harness = createHarness({
      args: ["--channel", "next"],
      version: "0.0.13",
      tags: { latest: "0.0.14", next: "0.0.15-next.0" },
    });

    const exitCode = await harness.run();

    expect(exitCode).toBe(1);
    expect(harness.output()).toContain("next");
    expect(harness.spawns).toEqual([]);
  });
});
