import type { CloudflareAgentsFiberPayload } from "./payload";

const retryLeaseIds = new WeakMap<
  CloudflareAgentsFiberPayload,
  string | null
>();

export function captureCloudflareAgentsRetryLeaseId(
  payload: CloudflareAgentsFiberPayload,
  leaseId: string | null
): void {
  retryLeaseIds.set(payload, leaseId);
}

export function capturedCloudflareAgentsRetryLeaseId(
  payload: CloudflareAgentsFiberPayload
): string | null | undefined {
  return retryLeaseIds.get(payload);
}
