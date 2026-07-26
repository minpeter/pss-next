import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodingAgentCli } from "./cli";

describe("coding-agent CLI", () => {
  it("prints usage when help is requested", async () => {
    let output = "";

    const exitCode = await runCodingAgentCli({
      argv: ["--help"],
      start: () =>
        Promise.reject(new Error("TUI should not start for help output")),
      stdout: {
        write(text: string): void {
          output += text;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Usage: pss [command]\n");
    expect(output).toContain("exec");
    expect(output).toContain("inspect-thread");
    expect(output).toContain("extension");
    expect(output).toContain("update");
  });

  it("routes exec with the remaining arguments to the headless command", async () => {
    const received: (readonly string[])[] = [];

    const exitCode = await runCodingAgentCli({
      argv: ["exec", "--stdin"],
      exec: (args) => {
        received.push(args);
        return Promise.resolve(0);
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual([["--stdin"]]);
  });

  it("routes update with the remaining arguments to the update command", async () => {
    const received: (readonly string[])[] = [];

    const exitCode = await runCodingAgentCli({
      argv: ["update", "--check"],
      update: (args) => {
        received.push(args);
        return Promise.resolve(0);
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual([["--check"]]);
  });

  it("propagates the TUI exit code", async () => {
    const exitCode = await runCodingAgentCli({
      argv: [],
      start: () => Promise.resolve(7),
    });

    expect(exitCode).toBe(7);
  });

  it("returns an error code with usage when the command is unknown", async () => {
    let output = "";

    const exitCode = await runCodingAgentCli({
      argv: ["wat"],
      start: () =>
        Promise.reject(new Error("TUI should not start for unknown commands")),
      stdout: {
        write(text: string): void {
          output += text;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("Unknown pss command: wat\n\n");
    expect(output).toContain("Usage: pss [command]\n");
  });

  it("routes inspect-thread through the local inspection surface", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-coding-agent-cli-"));
    let output = "";

    try {
      const exitCode = await runCodingAgentCli({
        argv: ["inspect-thread"],
        cwd: "/repo/demo",
        env: {
          PSS_THREAD_DIR: directory,
          PSS_THREAD_KEY: "workspace:demo",
        },
        home: "/home/me",
        stdout: {
          write(text: string): void {
            output += text;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(output).toContain("threadKey: workspace:demo\n");
      expect(output).toContain("messageCount: 0\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
