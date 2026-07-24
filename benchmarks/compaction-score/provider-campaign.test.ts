import { describe, expect, it } from "vitest";
import {
  createCampaignManifest,
  createPreflightReport,
  parseCampaignManifest,
} from "./campaign-manifest";
import { getCompactionPromptProfile } from "./prompt-profiles";
import {
  type CampaignValidationCode,
  CampaignValidationError,
  sanitizeProviderCampaignIdentity,
  validateOptionBCampaigns,
} from "./provider-campaign";

const productionProfile = getCompactionPromptProfile("production");
const profile = {
  hash: productionProfile.hash,
  id: productionProfile.id,
} as const;
const supported = {
  capability: "supported",
  status: "seeded-probe-succeeded",
} as const;
const options = {
  fixtures: 3,
  maxAttempts: 3,
  omitSummarySeed: false,
  seed: "compaction-score-v2",
  summaryMaxOutputTokens: 1024,
  trials: 2,
} as const;

const identity = (label: string, baseUrl: string, modelId: string) =>
  sanitizeProviderCampaignIdentity({ baseUrl, label, modelId });

function expectValidationCode(
  operation: () => unknown,
  code: CampaignValidationCode
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CampaignValidationError);
    expect(error).toMatchObject({ code, message: code });
    return;
  }
  expect.fail(`Expected ${code}`);
}

describe("provider campaign identity", () => {
  it("keeps only the normalized HTTP origin from a credentialed URL", () => {
    const provider = identity(
      " gateway ",
      "https://user:RAW_SECRET@api.example:8443/v1/chat?key=RAW_SECRET#private",
      " model-x "
    );

    expect(provider).toEqual({
      baseOrigin: "https://api.example:8443",
      label: "gateway",
      modelId: "model-x",
    });
    expect(JSON.stringify(provider)).not.toContain("RAW_SECRET");
    expect(JSON.stringify(provider)).not.toContain("/v1/chat");
  });

  it.each([
    [
      { baseUrl: "not a URL", label: "gateway", modelId: "model" },
      "provider-base-url-invalid",
    ],
    [
      { baseUrl: "", label: "gateway", modelId: "model" },
      "provider-base-url-invalid",
    ],
    [
      {
        baseUrl: "https://api.example/\u001b",
        label: "gateway",
        modelId: "model",
      },
      "provider-base-url-invalid",
    ],
    [
      { baseUrl: "ftp://api.example/v1", label: "gateway", modelId: "model" },
      "provider-base-url-protocol-invalid",
    ],
    [
      { baseUrl: "https://api.example", label: " \n", modelId: "model" },
      "provider-label-invalid",
    ],
    [
      {
        baseUrl: "https://api.example",
        label: "bad\u001blabel",
        modelId: "model",
      },
      "provider-label-invalid",
    ],
    [
      { baseUrl: "https://api.example", label: "gateway", modelId: "" },
      "provider-model-invalid",
    ],
    [
      {
        baseUrl: "https://api.example",
        label: "gateway",
        modelId: "bad\u007fmodel",
      },
      "provider-model-invalid",
    ],
  ] as const)("rejects malformed identity input with %s", (input, code) => {
    expectValidationCode(() => sanitizeProviderCampaignIdentity(input), code);
  });
});

describe("option-B campaign validation", () => {
  it("rejects duplicate sanitized tuples", () => {
    const first = identity("one", "https://one.example/v1", "model-a");
    expectValidationCode(
      () =>
        validateOptionBCampaigns([
          first,
          first,
          identity("two", "https://two.example/v1", "model-b"),
        ]),
      "campaign-tuple-duplicate"
    );
  });

  it("rejects three aliases that all use one base origin", () => {
    expectValidationCode(
      () =>
        validateOptionBCampaigns([
          identity("alias-a", "https://same.example/v1", "model-a"),
          identity("alias-b", "https://same.example/v2", "model-b"),
          identity("alias-c", "https://same.example/v3", "model-c"),
        ]),
      "campaign-origin-diversity-insufficient"
    );
  });

  it("requires three unique tuples and accepts two origins", () => {
    expectValidationCode(
      () =>
        validateOptionBCampaigns([
          identity("one", "https://one.example", "model-a"),
          identity("two", "https://two.example", "model-b"),
        ]),
      "campaign-tuple-count-insufficient"
    );

    expect(
      validateOptionBCampaigns([
        identity("one", "https://one.example/v1", "model-a"),
        identity("one", "https://one.example/v2", "model-b"),
        identity("two", "https://two.example/v1", "model-c"),
      ])
    ).toHaveLength(3);
  });
});

describe("campaign manifest", () => {
  it("whitelists manifest and report fields without secret sentinels", () => {
    const provider = {
      apiKey: "MANIFEST_SECRET",
      baseOrigin:
        "https://user:MANIFEST_SECRET@api.example/v1?token=MANIFEST_SECRET",
      label: "gateway",
      modelId: "model-x",
      rawUrl:
        "https://user:MANIFEST_SECRET@api.example/v1?token=MANIFEST_SECRET",
    };
    const taintedOptions = {
      ...options,
      authorization: "Bearer MANIFEST_SECRET",
    };
    const manifest = createCampaignManifest({
      createdAt: "2026-07-24T00:00:00.000Z",
      mode: "preflight",
      options: taintedOptions,
      profile,
      provider,
      seedCapability: supported,
    });
    const report = createPreflightReport(provider, supported);

    expect(JSON.stringify({ manifest, report })).not.toContain(
      "MANIFEST_SECRET"
    );
    expect(parseCampaignManifest(manifest)).toEqual(manifest);
  });

  it("rejects a manifest whose omission flag contradicts capability", () => {
    expectValidationCode(
      () =>
        createCampaignManifest({
          createdAt: "2026-07-24T00:00:00.000Z",
          mode: "preflight",
          options: { ...options, omitSummarySeed: true },
          profile,
          provider: identity("gateway", "https://api.example", "model-x"),
          seedCapability: supported,
        }),
      "campaign-manifest-invalid"
    );
  });

  it("requires profile attribution in every manifest", () => {
    const manifest = createCampaignManifest({
      createdAt: "2026-07-24T00:00:00.000Z",
      mode: "preflight",
      options,
      profile,
      provider: identity("gateway", "https://api.example", "model-x"),
      seedCapability: supported,
    });
    const withoutProfile = { ...manifest };
    Reflect.deleteProperty(withoutProfile, "profile");

    expectValidationCode(
      () => parseCampaignManifest(withoutProfile),
      "campaign-manifest-invalid"
    );
  });

  it("rejects malformed manifests without a model id", () => {
    expectValidationCode(
      () =>
        parseCampaignManifest({
          createdAt: "2026-07-24T00:00:00.000Z",
          mode: "preflight",
          options,
          profile,
          protocol: {},
          provider: {
            baseOrigin: "https://api.example",
            label: "gateway",
          },
          schemaVersion: 1,
          seedCapability: supported,
        }),
      "campaign-manifest-invalid"
    );
  });
});
