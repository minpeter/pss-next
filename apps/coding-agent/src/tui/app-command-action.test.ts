import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOptions } from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import { describe, expect, it } from "vitest";
import { startTui } from "./app";

const model = {
  doGenerate: () => Promise.reject(new Error("Unexpected model generation")),
  doStream: () => Promise.reject(new Error("Unexpected model stream")),
  modelId: "test-model",
  provider: "test",
  specificationVersion: "v4",
  supportedUrls: {},
} as AgentOptions["model"];

describe("TUI command actions", () => {
  it("ignores a legacy destructive new-session action", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "pss-app-command-action-"));
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousThreadDirectory = process.env.PSS_THREAD_DIR;
    const previousThreadKey = process.env.PSS_THREAD_KEY;
    process.chdir(directory);
    process.env.HOME = directory;
    process.env.PSS_THREAD_DIR = join(directory, "threads");
    process.env.PSS_THREAD_KEY = "app-command-action-test";
    const store = createFileHost({
      directory: process.env.PSS_THREAD_DIR,
    }).store.threads;
    await store.commit(
      "app-command-action-test",
      { state: { compactions: [], history: [], version: 2 } },
      { expectedVersion: null }
    );

    try {
      // When
      const exitCode = await startTui(
        { model },
        {
          createTui: async (config) => {
            await config.onCommandAction?.(
              JSON.parse('{"type":"new-session"}')
            );
          },
        }
      );

      // Then
      expect(exitCode).toBe(0);
      expect(await store.load("app-command-action-test")).not.toBeNull();
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousThreadDirectory === undefined) {
        delete process.env.PSS_THREAD_DIR;
      } else {
        process.env.PSS_THREAD_DIR = previousThreadDirectory;
      }
      if (previousThreadKey === undefined) {
        delete process.env.PSS_THREAD_KEY;
      } else {
        process.env.PSS_THREAD_KEY = previousThreadKey;
      }
      await rm(directory, { force: true, recursive: true });
    }
  });
});
