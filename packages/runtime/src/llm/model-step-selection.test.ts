import { describe, expect, it, vi } from "vitest";
import { parsePrepareModelStepResult } from "./model-step-selection";

describe("parsePrepareModelStepResult", () => {
  it("rejects accessor-backed model overrides without invoking getters", () => {
    let getterCalls = 0;
    const prepared: Record<string, unknown> = {};
    Object.defineProperty(prepared, "model", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });

    expect(() => parsePrepareModelStepResult(prepared, 0)).toThrow(
      'prepareModelStep field "model" must be a data property.'
    );
    expect(getterCalls).toBe(0);
  });

  it("accepts a doGenerate-only language model", () => {
    const model = {
      doGenerate: vi.fn(),
      modelId: "generate-only-model",
      provider: "fixture-provider",
      specificationVersion: "v4",
      supportedUrls: {},
    };

    expect(parsePrepareModelStepResult({ model }, 0)).toEqual({ model });
  });
});
