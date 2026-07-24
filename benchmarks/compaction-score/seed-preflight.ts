import { APICallError, generateText, type LanguageModel } from "ai";

export const PREFLIGHT_SEED = 2_147_483_647;

const SPECIFIC_SEED_REJECTION =
  /(?:\bseed\b\s*(?:parameter|field)?\s*(?:(?:is|was)\s*)?(?:not supported|unsupported|not allowed|unrecognized|unknown)|(?:(?:not supported|not allowed)|unsupported|unrecognized|unknown)(?:_|\s)+(?:parameter|field)\s*:?\s*["']?\bseed\b)/u;

export type SeedPreflightFailureCode =
  | "seed-omission-not-justified"
  | "seed-probe-authentication-failure"
  | "seed-probe-provider-failure"
  | "seed-probe-rate-limit-failure"
  | "seed-unsupported-requires-omission"
  | "seedless-health-probe-failure";

export class SeedPreflightError extends Error {
  readonly code: SeedPreflightFailureCode;
  readonly name = "SeedPreflightError";

  constructor(code: SeedPreflightFailureCode) {
    super(code);
    this.code = code;
  }
}

export type SeedCapabilityReport =
  | {
      readonly capability: "supported";
      readonly status: "seeded-probe-succeeded";
    }
  | {
      readonly capability: "unsupported";
      readonly status: "seeded-probe-rejected-seedless-probe-succeeded";
    };

export interface SeedCapabilityPreflightInput {
  readonly model: LanguageModel;
  readonly omitSeed: boolean;
}

export async function preflightSeedCapability({
  model,
  omitSeed,
}: SeedCapabilityPreflightInput): Promise<SeedCapabilityReport> {
  try {
    await probe(model, PREFLIGHT_SEED);
  } catch (error) {
    if (!isSpecificSeedUnsupportedError(error)) {
      throw new SeedPreflightError(classifyProbeFailure(error));
    }
    if (!omitSeed) {
      throw new SeedPreflightError("seed-unsupported-requires-omission");
    }
    try {
      await probe(model);
    } catch {
      throw new SeedPreflightError("seedless-health-probe-failure");
    }
    return {
      capability: "unsupported",
      status: "seeded-probe-rejected-seedless-probe-succeeded",
    };
  }

  if (omitSeed) {
    throw new SeedPreflightError("seed-omission-not-justified");
  }
  return {
    capability: "supported",
    status: "seeded-probe-succeeded",
  };
}

async function probe(model: LanguageModel, seed?: number): Promise<void> {
  await generateText({
    maxOutputTokens: 1,
    maxRetries: 0,
    messages: [
      {
        content: "Reply with OK.",
        role: "user",
      },
    ],
    model,
    ...(seed === undefined ? {} : { seed }),
    temperature: 0,
  });
}

function classifyProbeFailure(error: unknown): SeedPreflightFailureCode {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "seed-probe-authentication-failure";
    }
    if (error.statusCode === 429) {
      return "seed-probe-rate-limit-failure";
    }
  }
  return "seed-probe-provider-failure";
}

function isSpecificSeedUnsupportedError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    return false;
  }
  if (!(error.statusCode === 400 || error.statusCode === 422)) {
    return false;
  }
  const text = errorText(error).toLowerCase();
  return SPECIFIC_SEED_REJECTION.test(text);
}

function errorText(error: APICallError): string {
  const fields = [error.message, error.responseBody];
  try {
    fields.push(JSON.stringify(error.data));
  } catch {
    // Provider data is inspected transiently and never retained.
  }
  return fields
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}
