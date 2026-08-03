import { expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
} from "./mock-language-model";
import { preflightSeedCapability } from "./seed-preflight";

function rejectWhenAborted(
  options: MockLanguageModelV4CallOptions
): Promise<never> {
  const signal = options.abortSignal;
  if (!signal) {
    return new Promise(() => undefined);
  }
  return new Promise((_, reject) => {
    const rejectWithReason = () => reject(signal.reason);
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

it("bounds a seed capability probe that produces no output", {
  timeout: 1000,
}, async () => {
  const model = createMockLanguageModelV4(rejectWhenAborted);

  await expect(
    preflightSeedCapability({
      model,
      omitSeed: false,
      providerTimeoutMs: 10,
    })
  ).rejects.toMatchObject({
    code: "seed-probe-provider-failure",
    message: "seed-probe-provider-failure",
  });
});
