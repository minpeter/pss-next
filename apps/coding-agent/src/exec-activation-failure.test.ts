import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCodingAgent: vi.fn(),
  disposeAgent: vi.fn(),
}));

vi.mock("./coding-agent", () => ({
  createCodingAgent: mocks.createCodingAgent,
}));

import { runCodingAgentExec } from "./exec";

describe("exec extension activation failure", () => {
  it("disposes the created agent when activation fails", async () => {
    mocks.disposeAgent.mockReset();
    mocks.createCodingAgent.mockResolvedValue({
      dispose: mocks.disposeAgent,
    });

    await expect(
      runCodingAgentExec({
        extensions: [
          {
            default(pss) {
              pss.on("activate", () => {
                throw new Error("activation failed");
              });
            },
            id: "activation-failure",
          },
        ],
        model: {} as never,
        prompt: "hello",
        workspace: "/workspace",
      })
    ).rejects.toMatchObject({
      cause: { message: "activation failed" },
    });

    expect(mocks.disposeAgent).toHaveBeenCalledOnce();
  });
});
