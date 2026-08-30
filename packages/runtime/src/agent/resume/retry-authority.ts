interface ResumeRetryAttemptState {
  readonly leaseId: string;
  readonly prefix: string;
  readonly runId: string;
}

export interface ResumeRetryAttempt {
  readonly authority: object;
  readonly claim: object;
}

const claims = new WeakMap<object, ResumeRetryAttemptState>();
const authorities = new WeakMap<object, ResumeRetryAttemptState>();

export function createResumeRetryAttempt({
  prefix,
  runId,
}: {
  readonly prefix: string;
  readonly runId: string;
}): ResumeRetryAttempt {
  const state = { leaseId: crypto.randomUUID(), prefix, runId };
  const claim = Object.freeze({});
  const authority = Object.freeze({});
  claims.set(claim, state);
  authorities.set(authority, state);
  return { authority, claim };
}

export function leaseIdForResumeClaim(
  claim: object | undefined,
  runId: string
): string | undefined {
  const state = claim && claims.get(claim);
  if (claim) {
    claims.delete(claim);
  }
  return state?.runId === runId ? state.leaseId : undefined;
}

export function leaseIdForRetryAuthority(
  authority: object | undefined,
  prefix: string,
  runId: string
): string | undefined {
  const state = authority && authorities.get(authority);
  if (authority) {
    authorities.delete(authority);
  }
  return state?.prefix === prefix && state.runId === runId
    ? state.leaseId
    : undefined;
}
