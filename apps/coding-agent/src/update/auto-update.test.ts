import { describe, expect, it } from "vitest";
import {
  isAutoUpdateEnabled,
  planAutoUpdate,
  runAutoUpdate,
} from "./auto-update";
import type { UpdateNotice } from "./check";

describe("isAutoUpdateEnabled", () => {
  it("is enabled by explicit opt-in values", () => {
    expect(isAutoUpdateEnabled({ PSS_AUTO_UPDATE: "1" })).toBe(true);
    expect(isAutoUpdateEnabled({ PSS_AUTO_UPDATE: "true" })).toBe(true);
    expect(isAutoUpdateEnabled({ PSS_AUTO_UPDATE: "TRUE" })).toBe(true);
  });

  it("stays disabled without an explicit opt-in", () => {
    expect(isAutoUpdateEnabled({})).toBe(false);
    expect(isAutoUpdateEnabled({ PSS_AUTO_UPDATE: "0" })).toBe(false);
    expect(isAutoUpdateEnabled({ PSS_AUTO_UPDATE: "yes" })).toBe(false);
  });

  it("loses to the update check kill switch", () => {
    expect(
      isAutoUpdateEnabled({
        PSS_AUTO_UPDATE: "1",
        PSS_DISABLE_UPDATE_CHECK: "1",
      })
    ).toBe(false);
  });
});

describe("planAutoUpdate", () => {
  const globalBinPath =
    "/home/u/.local/share/pnpm/global/5/node_modules/@minpeter/pss-coding-agent/bin/pss.js";
  const channelUpdate: UpdateNotice = {
    kind: "channel-update",
    channel: "latest",
    currentVersion: "0.0.13",
    latestVersion: "0.0.14",
  };

  const plan = (overrides: {
    notice?: UpdateNotice | undefined;
    env?: NodeJS.ProcessEnv;
    binPath?: string;
    version?: string;
  }) =>
    planAutoUpdate({
      notice: "notice" in overrides ? overrides.notice : channelUpdate,
      version: overrides.version ?? "0.0.13",
      env: overrides.env ?? { PSS_AUTO_UPDATE: "1" },
      binPath: overrides.binPath ?? globalBinPath,
    });

  it("arms an in-channel same-major update on a confident global install", () => {
    expect(plan({})).toEqual({
      channel: "latest",
      currentVersion: "0.0.13",
      manager: "pnpm",
      target: "0.0.14",
    });
  });

  it("stays disarmed without a notice", () => {
    expect(plan({ notice: undefined })).toBeUndefined();
  });

  it("stays disarmed for a channel transition notice", () => {
    const stableSurpassed: UpdateNotice = {
      kind: "stable-surpassed",
      currentVersion: "0.0.14-next.2",
      latestVersion: "0.0.14",
    };
    expect(plan({ notice: stableSurpassed })).toBeUndefined();
  });

  it("stays disarmed without the opt-in", () => {
    expect(plan({ env: {} })).toBeUndefined();
  });

  it("stays disarmed across a major version jump", () => {
    const majorJump: UpdateNotice = {
      kind: "channel-update",
      channel: "latest",
      currentVersion: "0.0.13",
      latestVersion: "1.0.0",
    };
    expect(plan({ notice: majorJump })).toBeUndefined();
  });

  it("stays disarmed for ephemeral and unknown installs", () => {
    expect(
      plan({
        binPath:
          "/home/u/.npm/_npx/abc/node_modules/@minpeter/pss-coding-agent/bin/pss.js",
      })
    ).toBeUndefined();
    expect(plan({ binPath: "/opt/custom/bin/pss.js" })).toBeUndefined();
  });
});

describe("runAutoUpdate", () => {
  const collect = (
    spawnExitCode: number,
    tags: Readonly<Record<string, string>> = { latest: "0.0.14" }
  ) => {
    let output = "";
    const spawns: { command: string; args: readonly string[] }[] = [];
    return {
      output: () => output,
      spawns,
      run: () =>
        runAutoUpdate(
          {
            channel: "latest",
            currentVersion: "0.0.13",
            manager: "pnpm",
            target: "0.0.14",
          },
          {
            platform: "linux",
            stdout: {
              write(text: string): void {
                output += text;
              },
            },
            fetchTags: () => Promise.resolve(tags),
            spawnInstall: (command, args) => {
              spawns.push({ command, args });
              return Promise.resolve(spawnExitCode);
            },
          }
        ),
    };
  };

  it("installs the exact pinned version and asks for a restart", async () => {
    const harness = collect(0);

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.14"],
      },
    ]);
    expect(harness.output()).toContain("0.0.14");
    expect(harness.output()).toContain("Restart pss");
  });

  it("rechecks the channel and installs its freshest exact pin", async () => {
    const harness = collect(0, { latest: "0.0.15" });

    const exitCode = await harness.run();

    expect(exitCode).toBe(0);
    expect(harness.spawns).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@minpeter/pss-coding-agent@0.0.15"],
      },
    ]);
  });

  it("skips installation when the fresh channel is offline or crosses major", async () => {
    const offline = collect(0, {});
    const crossMajor = collect(0, { latest: "1.0.0" });

    expect(await offline.run()).toBe(0);
    expect(await crossMajor.run()).toBe(0);
    expect(offline.spawns).toEqual([]);
    expect(crossMajor.spawns).toEqual([]);
    expect(offline.output()).toContain("skipped");
    expect(crossMajor.output()).toContain("skipped");
  });

  it("propagates installer failures with the manual command", async () => {
    const harness = collect(4);

    const exitCode = await harness.run();

    expect(exitCode).toBe(4);
    expect(harness.output()).toContain(
      "pnpm add -g @minpeter/pss-coding-agent@0.0.14"
    );
  });
});
