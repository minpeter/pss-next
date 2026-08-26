export const MAX_CAMPAIGN_REPETITIONS = 100;

export function parseCampaignRepetitions(
  value: string | undefined,
  name: string
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return validateCampaignRepetitions(parsed, name);
}

export function validateCampaignRepetitions(
  value: number,
  name: string
): number {
  if (
    !(
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_CAMPAIGN_REPETITIONS
    )
  ) {
    throw new TypeError(
      `${name} must be an integer between 1 and ${MAX_CAMPAIGN_REPETITIONS}.`
    );
  }
  return value;
}
