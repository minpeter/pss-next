interface ResumeRetryAttemptState {
  leaseId: string;
  readonly runId: string;
  readonly scope: string;
}

export interface ResumeRetryAttempt {
  readonly authority: object;
  readonly claim: object;
}

const claims = new WeakMap<object, ResumeRetryAttemptState>();
const authorities = new WeakMap<object, ResumeRetryAttemptState>();

export function createResumeRetryAttempt({
  runId,
  scope,
}: {
  readonly runId: string;
  readonly scope: string;
}): ResumeRetryAttempt {
  const state = { leaseId: crypto.randomUUID(), runId, scope };
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

export function adoptResumeRetryLease(
  authority: object,
  leaseId: string,
  runId: string
): boolean {
  const state = authorities.get(authority);
  if (!state || state.runId !== runId) {
    return false;
  }
  state.leaseId = leaseId;
  return true;
}

export function leaseIdForRetryAuthority(
  authority: object | undefined,
  runId: string,
  scope: string
): string | undefined {
  const state = authority && authorities.get(authority);
  if (authority) {
    authorities.delete(authority);
  }
  return state?.runId === runId && state.scope === scope
    ? state.leaseId
    : undefined;
}
