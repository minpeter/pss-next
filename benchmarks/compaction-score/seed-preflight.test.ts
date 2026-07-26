import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "./mock-language-model";
import {
  PREFLIGHT_SEED,
  preflightSeedCapability,
  type SeedPreflightFailureCode,
} from "./seed-preflight";

const SECRET = "PROVIDER_SECRET_SENTINEL";

function providerError({
  message,
  responseBody = `{"raw":"${SECRET}"}`,
  statusCode,
}: {
  readonly message: string;
  readonly responseBody?: string;
  readonly statusCode: number;
}): APICallError {
  return new APICallError({
    isRetryable: statusCode === 429 || statusCode >= 500,
    message,
    requestBodyValues: { authorization: `Bearer ${SECRET}` },
    responseBody,
    statusCode,
    url: `https://user:${SECRET}@api.example/v1?token=${SECRET}`,
  });
}

async function expectPreflightCode(
  operation: Promise<unknown>,
  code: SeedPreflightFailureCode
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code, message: code });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    return;
  }
  expect.fail(`Expected ${code}`);
}

describe("seed capability preflight", () => {
  it("probes the real LanguageModel path with the deterministic seed", async () => {
    const calls: MockLanguageModelV4CallOptions[] = [];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.resolve(mockLanguageModelV4Text("ok"));
    });

    await expect(
      preflightSeedCapability({ model, omitSeed: false })
    ).resolves.toEqual({
      capability: "supported",
      status: "seeded-probe-succeeded",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      maxOutputTokens: 1,
      seed: PREFLIGHT_SEED,
      temperature: 0,
    });
  });

  it("requires explicit omission when the seeded probe is unsupported", async () => {
    const calls: MockLanguageModelV4CallOptions[] = [];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return Promise.reject(
        providerError({
          message: `${SECRET}: seed parameter is not supported`,
          statusCode: 400,
        })
      );
    });

    await expectPreflightCode(
      preflightSeedCapability({ model, omitSeed: false }),
      "seed-unsupported-requires-omission"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.seed).toBe(PREFLIGHT_SEED);
  });

  it("accepts omission only after unsupported seeded and healthy seedless probes", async () => {
    const calls: MockLanguageModelV4CallOptions[] = [];
    const model = createMockLanguageModelV4((options) => {
      calls.push(options);
      return calls.length === 1
        ? Promise.reject(
            providerError({
              message: "unsupported parameter: seed",
              responseBody: `{"error":{"param":"seed","code":"unsupported_parameter","detail":"${SECRET}"}}`,
              statusCode: 422,
            })
          )
        : Promise.resolve(mockLanguageModelV4Text("ok"));
    });

    const report = await preflightSeedCapability({ model, omitSeed: true });

    expect(report).toEqual({
      capability: "unsupported",
      status: "seeded-probe-rejected-seedless-probe-succeeded",
    });
    expect(calls.map(({ seed }) => seed)).toEqual([PREFLIGHT_SEED, undefined]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("rejects requested omission when the seeded probe succeeds", async () => {
    const model = createMockLanguageModelV4([
      mockLanguageModelV4Text("seed works"),
    ]);

    await expectPreflightCode(
      preflightSeedCapability({ model, omitSeed: true }),
      "seed-omission-not-justified"
    );
  });

  it.each([
    [401, "seed-probe-authentication-failure"],
    [429, "seed-probe-rate-limit-failure"],
    [503, "seed-probe-provider-failure"],
  ] as const)(
    "does not misclassify status %i as seed incompatibility",
    async (statusCode, code) => {
      const model = createMockLanguageModelV4(() =>
        Promise.reject(
          providerError({
            message: `${SECRET}: provider failure unrelated to parameters`,
            statusCode,
          })
        )
      );

      await expectPreflightCode(
        preflightSeedCapability({ model, omitSeed: true }),
        code
      );
    }
  );

  it("requires a successful seedless health probe", async () => {
    let call = 0;
    const model = createMockLanguageModelV4(() => {
      call += 1;
      return Promise.reject(
        call === 1
          ? providerError({
              message: "seed is not supported",
              statusCode: 400,
            })
          : providerError({
              message: `${SECRET}: upstream unavailable`,
              statusCode: 503,
            })
      );
    });

    await expectPreflightCode(
      preflightSeedCapability({ model, omitSeed: true }),
      "seedless-health-probe-failure"
    );
  });

  it("requires an error to reject seed specifically", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.reject(
        providerError({
          message:
            "seed=123 was accepted, but this model is not supported for the account",
          statusCode: 400,
        })
      )
    );

    await expectPreflightCode(
      preflightSeedCapability({ model, omitSeed: true }),
      "seed-probe-provider-failure"
    );
  });
});
