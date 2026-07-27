import { describe, expect, it, vi } from "vitest";
import { createModelCommand } from "./model-command";

const createHarness = (overrides?: { catalog?: string[] | Error }) => {
  let current = "model-a";
  const switchModel = vi.fn((modelId: string) => {
    current = modelId;
  });
  const catalog = overrides?.catalog ?? ["model-a", "model-b", "model-c"];
  const command = createModelCommand({
    currentModelId: () => current,
    listModelIds: () =>
      catalog instanceof Error
        ? Promise.reject(catalog)
        : Promise.resolve([...catalog]),
    switchModel,
  });
  return { command, switchModel, currentModelId: () => current };
};

describe("/model command", () => {
  it("switches to an explicit model id from the catalog", async () => {
    const { command, switchModel } = createHarness();

    const result = await command.execute({ args: ["model-b"] });

    expect(switchModel).toHaveBeenCalledWith("model-b");
    expect(result.success).toBe(true);
    expect(result.action).toEqual({ type: "refresh-header" });
    expect(result.message).toContain("Model switched to model-b");
  });

  it("opens the picker with a partial model id as its search query", async () => {
    const { command, switchModel } = createHarness();

    const result = await command.execute({ args: ["model", "b"] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: { query: "model b", type: "select-model" },
      success: true,
    });
  });

  it("uses the picker query when the catalog is unavailable", async () => {
    const { command, switchModel } = createHarness({
      catalog: new Error("catalog down"),
    });

    const result = await command.execute({ args: ["model-x"] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: { query: "model-x", type: "select-model" },
      success: true,
    });
  });

  it("is a no-op when the requested model is already active", async () => {
    const { command, switchModel } = createHarness();

    const result = await command.execute({ args: ["model-a"] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain("Model unchanged");
    expect(result.action).toBeUndefined();
  });

  it("asks the TUI to open the inline picker when called without args", async () => {
    const { command, switchModel } = createHarness();

    const result = await command.execute({ args: [] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      action: { type: "select-model" },
    });
  });

  it("prints the catalog for /model list", async () => {
    const { command } = createHarness();

    const result = await command.execute({ args: ["list"] });

    expect(result.success).toBe(true);
    expect(result.message).toContain("* model-a");
    expect(result.message).toContain("  model-b");
  });

  it("surfaces switch failures", async () => {
    const { command, switchModel } = createHarness();
    switchModel.mockImplementation(() => {
      throw new Error("boom");
    });

    const result = await command.execute({ args: ["model-b"] });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Model switch failed: boom");
  });
});
