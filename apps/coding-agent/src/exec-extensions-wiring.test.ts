import { beforeEach, describe, expect, it, vi } from "vitest";

const { configuredExtension, loadExtensions, runExec } = vi.hoisted(() => ({
  configuredExtension: {
    id: "configured-exec",
    default() {
      return;
    },
  },
  loadExtensions: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("./extensions/manager/loader", () => ({
  loadConfiguredCodingAgentExtensions: loadExtensions,
}));

vi.mock("./exec", () => ({
  runCodingAgentExec: runExec,
}));

import { runExecCli } from "./exec-cli";

describe("configured extension exec wiring", () => {
  beforeEach(() => {
    loadExtensions.mockReset();
    runExec.mockReset();
  });

  it("passes discovered extensions into headless execution", async () => {
    // Given
    loadExtensions.mockResolvedValue({
      extensions: [configuredExtension],
      notices: [],
    });
    runExec.mockResolvedValue({ status: "completed" });

    // When
    const code = await runExecCli({
      argv: ["--prompt", "hello"],
      cwd: "/workspace",
      env: {
        AI_API_KEY: "test",
        AI_BASE_URL: "https://example.com/v1",
        AI_MODEL: "test-model",
      },
      home: "/home/test",
      stdout: {
        write() {
          return;
        },
      },
    });

    // Then
    expect(code).toBe(0);
    expect(loadExtensions).toHaveBeenCalledWith({
      cwd: "/workspace",
      home: "/home/test",
    });
    expect(runExec).toHaveBeenCalledWith(
      expect.objectContaining({
        extensions: [configuredExtension],
        workspace: "/workspace",
      })
    );
  });
});
