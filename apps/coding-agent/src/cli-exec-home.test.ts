import { beforeEach, describe, expect, it, vi } from "vitest";

const { runExecCli } = vi.hoisted(() => ({
  runExecCli: vi.fn(),
}));

vi.mock("./exec-cli", () => ({ runExecCli }));

import { runCodingAgentCli } from "./cli";

describe("exec CLI context forwarding", () => {
  beforeEach(() => {
    runExecCli.mockReset();
  });

  it("forwards the configured home into extension discovery", async () => {
    // Given
    runExecCli.mockResolvedValue(0);

    // When
    const code = await runCodingAgentCli({
      argv: ["exec", "--prompt", "hello"],
      cwd: "/workspace",
      home: "/isolated-home",
    });

    // Then
    expect(code).toBe(0);
    expect(runExecCli).toHaveBeenCalledWith(
      expect.objectContaining({
        home: "/isolated-home",
      })
    );
  });
});
