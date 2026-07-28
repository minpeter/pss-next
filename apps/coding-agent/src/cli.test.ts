import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(output).toContain("Usage: pss [command] [-e <path>]\n");
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

  it("loads -e extensions for the TUI and overrides configured ids", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-cli-extension-"));
    try {
      await writeFile(
        join(root, "review-guard.mjs"),
        "export default function cliReviewGuard() {}\n",
        "utf8"
      );
      const started: (readonly { readonly id: string }[])[] = [];

      // When
      const exitCode = await runCodingAgentCli({
        argv: ["-e", "./review-guard.mjs"],
        cwd: root,
        loadExtensions: () =>
          Promise.resolve({
            extensions: [
              { default: () => undefined, id: "review-guard" },
              { default: () => undefined, id: "other" },
            ],
            notices: [],
          }),
        start: (extensions) => {
          started.push(extensions.map(({ id }) => ({ id })));
          return Promise.resolve(0);
        },
      });

      // Then
      expect(exitCode).toBe(0);
      expect(started).toEqual([[{ id: "other" }, { id: "review-guard" }]]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("accepts --name and starts the TUI", async () => {
    let started = 0;

    const exitCode = await runCodingAgentCli({
      argv: ["--name", "spike"],
      loadExtensions: () => Promise.resolve({ extensions: [], notices: [] }),
      start: () => {
        started += 1;
        return Promise.resolve(0);
      },
    });

    expect(exitCode).toBe(0);
    expect(started).toBe(1);
  });

  it("rejects --name without a value", async () => {
    let output = "";

    const exitCode = await runCodingAgentCli({
      argv: ["--name"],
      start: () =>
        Promise.reject(new Error("TUI should not start for bad flags")),
      stdout: {
        write(text: string): void {
          output += text;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("--name requires a value.");
  });

  it("rejects -e without a path value", async () => {
    let output = "";

    const exitCode = await runCodingAgentCli({
      argv: ["--extension"],
      start: () =>
        Promise.reject(new Error("TUI should not start for bad flags")),
      stdout: {
        write(text: string): void {
          output += text;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("--extension requires a path value.");
    expect(output).toContain("Usage: pss");
  });

  it("reports missing -e paths without starting the TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-cli-extension-"));
    try {
      let output = "";

      const exitCode = await runCodingAgentCli({
        argv: ["-e", "./missing.ts"],
        cwd: root,
        loadExtensions: () => Promise.resolve({ extensions: [], notices: [] }),
        start: () =>
          Promise.reject(new Error("TUI should not start for bad paths")),
        stdout: {
          write(text: string): void {
            output += text;
          },
        },
      });

      expect(exitCode).toBe(1);
      expect(output).toContain("--extension path not found");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
    expect(output).toContain("Usage: pss [command] [-e <path>]\n");
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

  it("inspects the active session unless PSS_THREAD_KEY forces a key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-coding-agent-cli-"));
    let output = "";

    try {
      await writeFile(
        join(directory, "sessions.json"),
        JSON.stringify({
          active: { "/repo/demo": "cwd:/repo/demo#abc" },
          schemaVersion: 1,
          sessions: [
            {
              createdAt: "2026-01-01T00:00:00.000Z",
              cwd: "/repo/demo",
              key: "cwd:/repo/demo#abc",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        })
      );

      const exitCode = await runCodingAgentCli({
        argv: ["inspect-thread"],
        cwd: "/repo/demo",
        env: { PSS_THREAD_DIR: directory },
        home: "/home/me",
        stdout: {
          write(text: string): void {
            output += text;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(output).toContain("threadKey: cwd:/repo/demo#abc\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
