// biome-ignore-all lint/performance/noBarrelFile: Internal Cloudflare Agents barrel for the canonical Cloudflare adapter.

export {
  type CloudflareHostOptions,
  createCloudflareHost,
} from "../host/create-cloudflare-host";
export {
  type CloudflareDurableObjectFetchOptions,
  type CloudflareDurableObjectId,
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectState,
  type CloudflareDurableObjectStub,
  type CloudflareDurableObjectStubOptions,
  fetchCloudflareDurableObject,
  getCloudflareDurableObjectStub,
} from "../host/durable-object-fetch";
export {
  type AgentTurnDrainResult,
  type AgentTurnDrainStopReason,
  type CloudflareAgentTurnDrainOptions,
  drainAgentTurn,
  drainAgentTurnWithBudget,
} from "../turn-drain";
export {
  type CloudflareAgentsResumableAgent,
  type CloudflarePlatformContext,
  type CloudflarePlatformContextOptions,
  type CloudflarePlatformFactoryOptions,
  type CloudflarePlatformPrefixGuard,
  type CloudflarePlatformPrefixGuardOptions,
  createCloudflarePlatformContext,
} from "./context";
export {
  type RecoverCloudflareAgentsFiberOptions,
  recoverCloudflareAgentsFiber,
  type StartCloudflareAgentsResumeFiberOptions,
  startCloudflareAgentsResumeFiber,
} from "./fiber";
export {
  ackScheduledCloudflareAgentsRun,
  ackScheduledCloudflareAgentsThreadPrompt,
  type CloudflareAgentsScheduledThreadPrompt,
  type DispatchCloudflareAgentsNotificationInput,
  dispatchCloudflareAgentsNotification,
  listScheduledCloudflareAgentsRuns,
  listScheduledCloudflareAgentsThreadPrompts,
} from "./operations";
export {
  type CloudflareAgentsFiberPayload,
  type CloudflareAgentsRunFiberPayload,
  type CloudflareAgentsThreadFiberPayload,
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsFiberMetadata,
  cloudflareAgentsFiberName,
  cloudflareAgentsRunPayload,
  cloudflareAgentsThreadPayload,
  defaultCloudflareAgentsDelayedResumeCallback,
  parseCloudflareAgentsFiberPayload,
  pssRunFiberName,
  pssThreadFiberName,
} from "./payload";
export {
  type CloudflareAgentsFiberRetrySchedulerOptions,
  createCloudflareAgentsFiberRetryScheduler,
} from "./retry-scheduler";
export {
  type ResumeScheduledCloudflareAgentsFiberOptions,
  resumeScheduledCloudflareAgentsFiber,
} from "./scheduled-fiber";
export {
  type CloudflareAgentsFiberSchedulerOptions,
  createCloudflareAgentsFiberScheduler,
} from "./scheduler";
export {
  areCloudflareAgentsPayloadsEquivalent,
  type CloudflareAgentsPayloadTrustOptions,
  type CloudflareAgentsPrefixGuard,
  type CloudflareAgentsPrefixGuardOptions,
  cloudflareAgentsTrustFailureReason,
  isCloudflareAgentsPayloadTrusted,
  isCloudflareAgentsRecoveryContextTrusted,
  rejectedCloudflareAgentsFiberResult,
} from "./trust";
export type {
  CloudflareAgentsCallbackName,
  CloudflareAgentsDefaultResumeAgent,
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsEventHandler,
  CloudflareAgentsFiberContext,
  CloudflareAgentsFiberInspection,
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflareAgentsFiberStatus,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsRetryFiber,
  CloudflareAgentsRetryReason,
  CloudflareAgentsRunContext,
  CloudflareAgentsRunSource,
  CloudflareAgentsSchedule,
  CloudflareAgentsScheduledRunContext,
  CloudflareAgentsScheduleOptions,
  CloudflareAgentsScheduleRetryOptions,
  CloudflareAgentsStartFiberOptions,
  CloudflareAgentsStartFiberResult,
  CloudflareAgentsThreadPromptContext,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

/** Lazy so Node tests can import the Cloudflare entry without loading .wasm. */
export async function installCloudflareImageCodecs(): Promise<void> {
  const { installCloudflareImageCodecs: install } = await import(
    "../image-codecs-edge"
  );
  install();
}
