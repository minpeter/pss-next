export const runtimeRootDeclaration = [
  'export type { AgentHost } from "./execution/types";',
  'export type { AgentInstrumentation, AgentInstrumentationContext, AgentInstrumentationOperation } from "./agent";',
  'export type { AgentTurn, RuntimeInput } from "./thread";',
  "",
].join("\n");
export const runtimeChannelDeclaration = [
  'export type { ChannelInboundMessage, ChannelAssistantTextDelivery, ChannelAssistantDelivery } from "./index";',
  'export { projectChannelAssistantDelivery } from "./index";',
  "",
].join("\n");
export const runtimeExecutionDeclaration = [
  'export type { AdmitReceipt, AdmitThreadInput, CheckpointStore, ClaimedThreadInput, ClaimThreadInputOptions, DurableTurnInspectionResult, DurableTurnInspectionSource, EventStore, AgentHost, HostScheduler, HostStore, HostStoreTransaction, NotificationInbox, NotificationRecord, RecoverThreadInputClaimsResult, ThreadInputBoundary, ThreadInputInbox, ThreadInputKind, ThreadInputPlacement, ThreadInputRecord, ThreadInputStatus, TurnRecord, TurnStatus, TurnStore } from "./types";',
  'export { inspectDurableTurn, threadStoreFromHost } from "./host";',
  'export { ThreadInputDuplicateConflictError } from "./types";',
  'export type { RuntimeToolExecutionCheckpoint, RuntimeToolExecutionContext, RuntimeToolExecutionDecision, RuntimeToolRetryPolicy } from "../llm-tool-execution";',
  'export { ToolExecutionNeedsRecoveryError } from "../llm-tool-execution";',
  "",
].join("\n");
export const runtimeMemoryDeclaration = [
  'export { createInMemoryHost, InMemoryExecutionScheduler, MemoryThreadStore } from "./index";',
  'export type { InMemoryHost, MemoryScheduledThreadPrompt, MemoryScheduledWorkListOptions } from "./index";',
  "",
].join("\n");
export const runtimeDurableObjectDeclaration = [
  'export { ackScheduledDurableObjectRun, ackScheduledDurableObjectThreadPrompt, createDurableObjectScheduledWorkScheduler, createDurableObjectStorageHost, DurableObjectAttachmentStore, DurableObjectExecutionStore, DurableObjectSqliteCheckpointStore, DurableObjectSqliteEventStore, DurableObjectSqliteThreadStore, InMemoryDurableObjectStorage, listScheduledDurableObjectRuns, listScheduledDurableObjectThreadPrompts } from "./index";',
  'export type { DurableObjectScheduledThreadPrompt, DurableObjectStorage, DurableObjectStorageHostOptions, SqlStorage } from "./index";',
  "",
].join("\n");
export const runtimeCloudflareWorkerDeclaration = [
  'export { createCloudflareHost, drainAgentTurn, drainAgentTurnWithBudget, fetchCloudflareDurableObject, getCloudflareDurableObjectStub } from "./index";',
  'export type { AgentTurnDrainResult, AgentTurnDrainStopReason, CloudflareAgentTurnDrainOptions, CloudflareDurableObjectFetchOptions, CloudflareDurableObjectId, CloudflareDurableObjectNamespace, CloudflareDurableObjectState, CloudflareDurableObjectStub, CloudflareDurableObjectStubOptions, CloudflareHostOptions } from "./index";',
  "",
].join("\n");
const runtimeCloudflareAgentsDeclaration = [
  'export { ackScheduledCloudflareAgentsRun, ackScheduledCloudflareAgentsThreadPrompt, areCloudflareAgentsPayloadsEquivalent, cloudflareAgentsFiberIdempotencyKey, cloudflareAgentsFiberMetadata, cloudflareAgentsFiberName, cloudflareAgentsRunPayload, cloudflareAgentsThreadPayload, cloudflareAgentsTrustFailureReason, createCloudflareAgentsFiberScheduler, createCloudflareAgentsFiberRetryScheduler, createCloudflarePlatformContext, defaultCloudflareAgentsDelayedResumeCallback, dispatchCloudflareAgentsNotification, isCloudflareAgentsPayloadTrusted, isCloudflareAgentsRecoveryContextTrusted, listScheduledCloudflareAgentsRuns, listScheduledCloudflareAgentsThreadPrompts, parseCloudflareAgentsFiberPayload, pssRunFiberName, pssThreadFiberName, recoverCloudflareAgentsFiber, rejectedCloudflareAgentsFiberResult, resumeScheduledCloudflareAgentsFiber, startCloudflareAgentsResumeFiber } from "./index";',
  'export type { CloudflareAgentsCallbackName, CloudflareAgentsDurableObjectContext, CloudflareAgentsEventHandler, CloudflareAgentsFiberContext, CloudflareAgentsFiberPayload, CloudflareAgentsFiberRecoveryContext, CloudflareAgentsFiberRecoveryResult, CloudflareAgentsFiberRetrySchedulerOptions, CloudflareAgentsFiberSchedulerOptions, CloudflareAgentsFiberStatus, CloudflareAgentsPayloadTrustOptions, CloudflareAgentsPlatformAgent, CloudflarePlatformContext, CloudflarePlatformContextOptions, CloudflarePlatformFactoryOptions, CloudflarePlatformPrefixGuard, CloudflarePlatformPrefixGuardOptions, CloudflareAgentsPrefixGuard, CloudflareAgentsPrefixGuardOptions, CloudflareAgentsResumeRun, CloudflareAgentsResumableAgent, CloudflareAgentsRunFiberPayload, CloudflareAgentsRunContext, CloudflareAgentsRunSource, CloudflareAgentsSchedule, CloudflareAgentsScheduleOptions, CloudflareAgentsScheduledRunContext, CloudflareAgentsScheduledThreadPrompt, CloudflareAgentsStartFiberOptions, CloudflareAgentsStartFiberResult, CloudflareAgentsThreadFiberPayload, CloudflareAgentsThreadPromptContext, CloudflareAgentsTurnDrainOptions, DispatchCloudflareAgentsNotificationInput, RecoverCloudflareAgentsFiberOptions, ResumeScheduledCloudflareAgentsFiberOptions, StartCloudflareAgentsResumeFiberOptions } from "./index";',
  "",
].join("\n");
export const runtimeCloudflareDeclaration = [
  runtimeCloudflareWorkerDeclaration,
  runtimeCloudflareAgentsDeclaration,
].join("");
export const runtimeFileDeclaration = [
  'export { ackScheduledNodeRun, ackScheduledNodeThreadPrompt, appendScheduledNodeRun, appendScheduledNodeThreadPrompt, createNodeFileAgentContext, createFileHost, createFileScheduler, drainScheduledNodeWork, FileExecutionStore, FileThreadStore, listScheduledNodeRuns, listScheduledNodeThreadPrompts } from "./index";',
  'export type { NodeFileAgentContext, NodeFileAgentContextFactoryOptions, NodeFileAgentContextOptions, FileHostOptions, NodeScheduledThreadPrompt, NodeScheduledWorkAppendOptions, NodeScheduledWorkDrainOptions, NodeScheduledWorkDrainResult, NodeScheduledWorkListOptions, NodeScheduledWorkRunContext } from "./index";',
  "",
].join("\n");
export const runtimeOtelDeclaration = [
  'export { openTelemetry, traceAgentTurn } from "./index";',
  'export type { TraceAgentTurnEventAttributes, TraceAgentTurnOptions, TraceAgentTurnSpan, TraceAgentTurnTracer } from "./index";',
  "",
].join("\n");
