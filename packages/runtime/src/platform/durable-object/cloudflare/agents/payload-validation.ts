export const maxIdLength = 1024;
export const maxPrefixLength = 256;

export interface RunPayloadFields {
  readonly attempt?: number;
  readonly prefix: string;
  readonly runId: string;
}

export interface ThreadPayloadFields extends RunPayloadFields {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly threadKey: string;
}

export function hasRunPayloadStrings(
  value: Record<string, unknown>
): value is Record<string, unknown> & RunPayloadFields {
  return (
    isOptionalPayloadAttempt(value.attempt) &&
    isPayloadString(value.prefix, maxPrefixLength) &&
    isPayloadString(value.runId, maxIdLength)
  );
}

export function hasThreadPayloadStrings(
  value: Record<string, unknown>
): value is Record<string, unknown> & ThreadPayloadFields {
  return (
    isOptionalPayloadAttempt(value.attempt) &&
    isOptionalPayloadString(value.idempotencyKey, maxIdLength) &&
    isOptionalPayloadString(value.notificationId, maxIdLength) &&
    isPayloadString(value.prefix, maxPrefixLength) &&
    isPayloadString(value.runId, maxIdLength) &&
    isPayloadString(value.threadKey, maxIdLength)
  );
}

export function assertPayloadString(
  name: string,
  value: string,
  maxLength: number
): void {
  if (!isPayloadString(value, maxLength)) {
    throw new TypeError(
      `Cloudflare Agents payload ${name} must be a non-empty string up to ${maxLength} characters`
    );
  }
}

export function assertOptionalPayloadString(
  name: string,
  value: string | undefined,
  maxLength: number
): void {
  if (!isOptionalPayloadString(value, maxLength)) {
    throw new TypeError(
      `Cloudflare Agents payload ${name} must be a non-empty string up to ${maxLength} characters when provided`
    );
  }
}

export function assertOptionalPayloadAttempt(
  name: string,
  value: number | undefined
): void {
  if (!isOptionalPayloadAttempt(value)) {
    throw new TypeError(
      `Cloudflare Agents payload ${name} must be a non-negative safe integer when provided`
    );
  }
}

function isPayloadString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isOptionalPayloadString(
  value: unknown,
  maxLength: number
): value is string | undefined {
  return value === undefined || isPayloadString(value, maxLength);
}

function isOptionalPayloadAttempt(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}
