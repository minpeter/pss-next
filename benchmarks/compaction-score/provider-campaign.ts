export type CampaignValidationCode =
  | "campaign-manifest-invalid"
  | "campaign-origin-diversity-insufficient"
  | "campaign-provider-origin-count-insufficient"
  | "campaign-tuple-count-insufficient"
  | "campaign-tuple-duplicate"
  | "provider-base-url-invalid"
  | "provider-base-url-protocol-invalid"
  | "provider-label-invalid"
  | "provider-model-invalid";

export class CampaignValidationError extends Error {
  readonly code: CampaignValidationCode;
  readonly name = "CampaignValidationError";

  constructor(code: CampaignValidationCode) {
    super(code);
    this.code = code;
  }
}

export interface ProviderCampaignIdentityInput {
  readonly baseUrl: string;
  readonly label: string;
  readonly modelId: string;
}

export interface ProviderCampaignIdentity {
  readonly baseOrigin: string;
  readonly label: string;
  readonly modelId: string;
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    );
  });
}

export function sanitizeProviderCampaignIdentity(
  input: ProviderCampaignIdentityInput
): ProviderCampaignIdentity {
  const label = validatedIdentifier(input.label, "provider-label-invalid");
  const modelId = validatedIdentifier(input.modelId, "provider-model-invalid");
  if (
    typeof input.baseUrl !== "string" ||
    input.baseUrl.trim().length === 0 ||
    hasControlCharacters(input.baseUrl)
  ) {
    throw new CampaignValidationError("provider-base-url-invalid");
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new CampaignValidationError("provider-base-url-invalid");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    throw new CampaignValidationError("provider-base-url-protocol-invalid");
  }

  return { baseOrigin: url.origin, label, modelId };
}

export function validateOptionBCampaigns(
  identities: readonly ProviderCampaignIdentity[]
): readonly ProviderCampaignIdentity[] {
  const normalized = identities.map(({ baseOrigin, label, modelId }) =>
    sanitizeProviderCampaignIdentity({ baseUrl: baseOrigin, label, modelId })
  );
  const tuples = normalized.map(({ baseOrigin, label, modelId }) =>
    JSON.stringify([label, baseOrigin, modelId])
  );
  if (new Set(tuples).size !== tuples.length) {
    throw new CampaignValidationError("campaign-tuple-duplicate");
  }
  if (tuples.length < 3) {
    throw new CampaignValidationError("campaign-tuple-count-insufficient");
  }

  const providerOrigins = new Set(
    normalized.map(({ baseOrigin, label }) =>
      JSON.stringify([label, baseOrigin])
    )
  );
  if (providerOrigins.size < 2) {
    throw new CampaignValidationError(
      "campaign-provider-origin-count-insufficient"
    );
  }
  if (new Set(normalized.map(({ baseOrigin }) => baseOrigin)).size < 2) {
    throw new CampaignValidationError("campaign-origin-diversity-insufficient");
  }
  return normalized;
}

function validatedIdentifier(
  value: string,
  code: "provider-label-invalid" | "provider-model-invalid"
): string {
  if (
    typeof value !== "string" ||
    hasControlCharacters(value) ||
    value.trim().length === 0
  ) {
    throw new CampaignValidationError(code);
  }
  return value.trim();
}
