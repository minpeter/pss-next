import { describe, expect, it, vi } from "vitest";
import { createModelCommand } from "./model-command";

const createHarness = (overrides?: {
  catalog?: string[] | Error;
  select?: (input: {
    readonly label: string;
    readonly options: readonly {
      readonly description?: string;
      readonly label: string;
      readonly value: string;
    }[];
  }) => Promise<string | undefined>;
}) => {
  let current = "model-a";
  const switchModel = vi.fn((modelId: string) => {
    current = modelId;
  });
  const catalog = overrides?.catalog ?? ["model-a", "model-b", "model-c"];
  const command = createModelCommand({
    currentModelId: () => current,
    getSelect: () => overrides?.select,
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

  it("rejects ids that are not in the catalog", async () => {
    const { command, switchModel } = createHarness();

    const result = await command.execute({ args: ["nope"] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown model "nope"');
  });

  it("switches blindly with a note when the catalog is unavailable", async () => {
    const { command, switchModel } = createHarness({
      catalog: new Error("catalog down"),
    });

    const result = await command.execute({ args: ["model-x"] });

    expect(switchModel).toHaveBeenCalledWith("model-x");
    expect(result.success).toBe(true);
    expect(result.message).toContain("catalog unavailable");
  });

  it("is a no-op when the requested model is already active", async () => {
    const { command, switchModel } = createHarness();

    const result = await command.execute({ args: ["model-a"] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain("Model unchanged");
    expect(result.action).toBeUndefined();
  });

  it("opens the picker without args and applies the selection", async () => {
    const select = vi.fn().mockResolvedValue("model-c");
    const { command, switchModel } = createHarness({ select });

    const result = await command.execute({ args: [] });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        label: expect.stringContaining("current: model-a"),
      })
    );
    const options = select.mock.calls[0]?.[0]?.options;
    expect(options).toContainEqual({
      label: "model-a",
      value: "model-a",
      description: "current",
    });
    expect(switchModel).toHaveBeenCalledWith("model-c");
    expect(result.action).toEqual({ type: "refresh-header" });
  });

  it("keeps the current model when the picker is cancelled", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    const { command, switchModel } = createHarness({ select });

    const result = await command.execute({ args: [] });

    expect(switchModel).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain("Model unchanged (model-a)");
  });

  it("prints the catalog when no picker UI is available", async () => {
    const { command } = createHarness();

    const result = await command.execute({ args: [] });

    expect(result.success).toBe(true);
    expect(result.message).toContain("* model-a");
    expect(result.message).toContain("  model-b");
  });

  it("prints the catalog for /model list", async () => {
    const select = vi.fn();
    const { command } = createHarness({ select });

    const result = await command.execute({ args: ["list"] });

    expect(select).not.toHaveBeenCalled();
    expect(result.message).toContain("* model-a");
  });

  it("reports a helpful error when the catalog cannot be loaded for the picker", async () => {
    const { command } = createHarness({ catalog: new Error("catalog down") });

    const result = await command.execute({ args: [] });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Current model: model-a");
    expect(result.message).toContain("catalog down");
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
