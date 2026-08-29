export const REQUIRED_RUNTIME_ROOT_EXPORTS = [
  "AgentHost",
  "AgentInstrumentation",
  "AgentInstrumentationContext",
  "AgentInstrumentationOperation",
  "AgentTurn",
  "RuntimeInput",
];

export const REQUIRED_RUNTIME_CHANNEL_EXPORTS = [
  "ChannelInboundMessage",
  "ChannelAssistantTextDelivery",
  "ChannelAssistantDelivery",
  "projectChannelAssistantDelivery",
];

export const REQUIRED_RUNTIME_EXECUTION_EXPORTS = [
  "AdmitReceipt",
  "AdmitThreadInput",
  "CheckpointStore",
  "ClaimedThreadInput",
  "ClaimThreadInputOptions",
  "AgentHost",
  "DurableTurnInspectionResult",
  "DurableTurnInspectionSource",
  "EventStore",
  "HostScheduler",
  "HostStore",
  "HostStoreTransaction",
  "NotificationInbox",
  "NotificationRecord",
  "RecoverThreadInputClaimsResult",
  "ThreadInputBoundary",
  "ThreadInputDuplicateConflictError",
  "ThreadInputInbox",
  "ThreadInputKind",
  "ThreadInputPlacement",
  "ThreadInputRecord",
  "ThreadInputStatus",
  "TurnRecord",
  "TurnStore",
  "TurnStatus",
  "RuntimeToolExecutionCheckpoint",
  "RuntimeToolExecutionContext",
  "RuntimeToolExecutionDecision",
  "RuntimeToolRetryPolicy",
  "ToolExecutionNeedsRecoveryError",
  "inspectDurableTurn",
  "threadStoreFromHost",
];

export const REQUIRED_RUNTIME_MEMORY_EXPORTS = [
  "createInMemoryHost",
  "InMemoryHost",
  "InMemoryExecutionScheduler",
  "MemoryScheduledThreadPrompt",
  "MemoryScheduledWorkListOptions",
  "MemoryThreadStore",
];

export const REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS = [
  "AgentTurnDrainResult",
  "AgentTurnDrainStopReason",
  "CloudflareAgentTurnDrainOptions",
  "CloudflareDurableObjectFetchOptions",
  "CloudflareDurableObjectId",
  "CloudflareDurableObjectNamespace",
  "CloudflareDurableObjectState",
  "CloudflareDurableObjectStub",
  "CloudflareDurableObjectStubOptions",
  "createCloudflareHost",
  "CloudflareHostOptions",
  "drainAgentTurn",
  "drainAgentTurnWithBudget",
  "fetchCloudflareDurableObject",
  "getCloudflareDurableObjectStub",
];

export const REQUIRED_RUNTIME_DURABLE_OBJECT_EXPORTS = [
  "DurableObjectAttachmentStore",
  "DurableObjectExecutionStore",
  "DurableObjectScheduledThreadPrompt",
  "DurableObjectSqliteCheckpointStore",
  "DurableObjectSqliteEventStore",
  "DurableObjectSqliteThreadStore",
  "DurableObjectStorage",
  "DurableObjectStorageHostOptions",
  "InMemoryDurableObjectStorage",
  "SqlStorage",
  "ackScheduledDurableObjectRun",
  "ackScheduledDurableObjectThreadPrompt",
  "createDurableObjectScheduledWorkScheduler",
  "createDurableObjectStorageHost",
  "listScheduledDurableObjectRuns",
  "listScheduledDurableObjectThreadPrompts",
];

export const REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS = [
  "CloudflareAgentsCallbackName",
  "CloudflareAgentsDurableObjectContext",
  "CloudflareAgentsEventHandler",
  "CloudflareAgentsFiberContext",
  "CloudflareAgentsFiberPayload",
  "CloudflareAgentsFiberRecoveryContext",
  "CloudflareAgentsFiberRecoveryResult",
  "CloudflareAgentsFiberRetrySchedulerOptions",
  "CloudflareAgentsFiberSchedulerOptions",
  "CloudflareAgentsFiberStatus",
  "CloudflareAgentsPayloadTrustOptions",
  "CloudflareAgentsPlatformAgent",
  "CloudflarePlatformContext",
  "CloudflarePlatformContextOptions",
  "CloudflarePlatformFactoryOptions",
  "CloudflarePlatformPrefixGuard",
  "CloudflarePlatformPrefixGuardOptions",
  "CloudflareAgentsPrefixGuard",
  "CloudflareAgentsPrefixGuardOptions",
  "CloudflareAgentsResumeRun",
  "CloudflareAgentsResumableAgent",
  "CloudflareAgentsRunFiberPayload",
  "CloudflareAgentsRunContext",
  "CloudflareAgentsRunSource",
  "CloudflareAgentsSchedule",
  "CloudflareAgentsScheduleOptions",
  "CloudflareAgentsScheduledRunContext",
  "CloudflareAgentsScheduledThreadPrompt",
  "CloudflareAgentsStartFiberOptions",
  "CloudflareAgentsStartFiberResult",
  "CloudflareAgentsThreadFiberPayload",
  "CloudflareAgentsThreadPromptContext",
  "CloudflareAgentsTurnDrainOptions",
  "DispatchCloudflareAgentsNotificationInput",
  "RecoverCloudflareAgentsFiberOptions",
  "ResumeScheduledCloudflareAgentsFiberOptions",
  "StartCloudflareAgentsResumeFiberOptions",
  "ackScheduledCloudflareAgentsRun",
  "ackScheduledCloudflareAgentsThreadPrompt",
  "areCloudflareAgentsPayloadsEquivalent",
  "cloudflareAgentsFiberIdempotencyKey",
  "cloudflareAgentsFiberMetadata",
  "cloudflareAgentsFiberName",
  "cloudflareAgentsRunPayload",
  "cloudflareAgentsThreadPayload",
  "cloudflareAgentsTrustFailureReason",
  "createCloudflareAgentsFiberScheduler",
  "createCloudflareAgentsFiberRetryScheduler",
  "createCloudflarePlatformContext",
  "defaultCloudflareAgentsDelayedResumeCallback",
  "dispatchCloudflareAgentsNotification",
  "isCloudflareAgentsPayloadTrusted",
  "isCloudflareAgentsRecoveryContextTrusted",
  "listScheduledCloudflareAgentsRuns",
  "listScheduledCloudflareAgentsThreadPrompts",
  "parseCloudflareAgentsFiberPayload",
  "pssRunFiberName",
  "pssThreadFiberName",
  "recoverCloudflareAgentsFiber",
  "rejectedCloudflareAgentsFiberResult",
  "resumeScheduledCloudflareAgentsFiber",
  "startCloudflareAgentsResumeFiber",
];

export const REQUIRED_RUNTIME_CLOUDFLARE_EXPORTS = [
  ...REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS,
  ...REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS,
];

export const REQUIRED_RUNTIME_FILE_EXPORTS =
  "FileExecutionStore FileThreadStore NodeFileAgentContext NodeFileAgentContextFactoryOptions NodeFileAgentContextOptions FileHostOptions NodeScheduledThreadPrompt NodeScheduledWorkAppendOptions NodeScheduledWorkDrainOptions NodeScheduledWorkDrainResult NodeScheduledWorkListOptions NodeScheduledWorkRunContext ackScheduledNodeRun ackScheduledNodeThreadPrompt appendScheduledNodeRun appendScheduledNodeThreadPrompt createNodeFileAgentContext createFileHost createFileScheduler drainScheduledNodeWork listScheduledNodeRuns listScheduledNodeThreadPrompts".split(
    " "
  );

export const REQUIRED_RUNTIME_OTEL_EXPORTS =
  "TraceAgentTurnEventAttributes TraceAgentTurnOptions TraceAgentTurnSpan TraceAgentTurnTracer openTelemetry traceAgentTurn".split(
    " "
  );

export const FORBIDDEN_RUNTIME_ROOT_NAMES = [
  ...new Set([
    ...[
      "AgentMessage AgentModel AgentLoopResult AgentRun AgentRunInput AgentTool AgentTools",
      "BackgroundScheduler BackgroundSchedulerHost CheckpointHost CheckpointStore",
      "CloudflarePlatformContext CloudflarePlatformContextOptions CloudflarePlatformFactoryOptions",
      "AgentTurnDrainResult AgentTurnDrainStopReason CloudflareAgentTurnDrainOptions",
      "CloudflareDurableObjectFetchOptions CloudflareDurableObjectId",
      "CloudflareDurableObjectNamespace CloudflareDurableObjectState CloudflareDurableObjectStorage",
      "CloudflareDurableObjectStub CloudflareDurableObjectStubOptions CloudflareScheduledThreadPrompt",
      "createInMemoryHost createCloudflareScheduledWorkScheduler createCloudflarePlatformContext",
      "createCloudflareAgentsFiberScheduler createCloudflarePlatformContext createCloudflareStorageHost",
      "createCloudflareHost CreateLlmOptions DurableNotificationResumeHost",
      "drainAgentTurn drainAgentTurnWithBudget EventHost EventStore HostScheduler HostStore",
      "HostStoreTransaction ExecutionTransactionHost Llm LlmContext LlmOutput LlmOutputPart",
      "NotificationHost NotificationInbox NotificationRecord fetchCloudflareDurableObject",
      "getCloudflareDurableObjectStub InMemoryCloudflareDurableObjectStorage RunHost RunRecord",
      "InMemoryHost InMemoryExecutionScheduler MemoryScheduledThreadPrompt MemoryScheduledWorkListOptions MemoryThreadStore",
      "RunInput RunStore RuntimeToolExecutionCheckpoint RuntimeToolExecutionContext",
      "RuntimeToolExecutionDecision RuntimeToolRetryPolicy",
      "FileExecutionStore FileThreadStore FileSessionStore NodeFileAgentContext",
      "NodeFileAgentContextFactoryOptions NodeFileAgentContextOptions FileHostOptions",
      "NodeScheduledThreadPrompt NodeScheduledWorkAppendOptions",
      "NodeScheduledWorkDrainOptions NodeScheduledWorkDrainResult NodeScheduledWorkListOptions NodeScheduledWorkRunContext",
      "ackScheduledNodeRun ackScheduledNodeThreadPrompt appendScheduledNodeRun appendScheduledNodeThreadPrompt",
      "createNodeFileAgentContext createFileHost createFileScheduler drainScheduledNodeWork",
      "listScheduledNodeRuns listScheduledNodeThreadPrompts",
    ].flatMap((names) => names.split(" ")),
    // Every platform-subpath export is forbidden on the root surface; spread
    // the required lists so the two can never drift apart.
    ...REQUIRED_RUNTIME_EXECUTION_EXPORTS.filter(
      (name) => name !== "AgentHost"
    ),
    ...REQUIRED_RUNTIME_CLOUDFLARE_AGENTS_EXPORTS,
    ...REQUIRED_RUNTIME_CLOUDFLARE_WORKER_EXPORTS,
    ...REQUIRED_RUNTIME_DURABLE_OBJECT_EXPORTS,
    ...REQUIRED_RUNTIME_FILE_EXPORTS,
    ...REQUIRED_RUNTIME_MEMORY_EXPORTS,
    ...REQUIRED_RUNTIME_CHANNEL_EXPORTS,
    ["create", "Llm"].join(""),
    ["Runtime", "Create", "Llm", "Options"].join(""),
    ["Runtime", "Llm"].join(""),
    ["Runtime", "Llm", "Context"].join(""),
    ["Runtime", "Llm", "Output"].join(""),
    ["Runtime", "Llm", "Output", "Part"].join(""),
    "runAgentLoop",
    "ToolExecutionNeedsRecoveryError",
    "SessionHost",
  ]),
];

export const FORBIDDEN_RUNTIME_PUBLIC_PATTERNS = [
  {
    description: "AgentRun.stream() API",
    pattern: /\bstream\(\): AsyncIterable(?:Iterator)?<AgentEvent>/,
  },
  {
    description: "AgentRun.stream() member",
    pattern: /(?:\bstream\(\)\s*\{|AgentRun\.stream\(\))/,
  },
];

export const FORBIDDEN_RUNTIME_MODEL_ADAPTER_NAMES = [
  ["create", "Llm"].join(""),
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
];

export const FORBIDDEN_RUNTIME_SUBAGENT_NAMES = [
  ["Subagent", "Definition"].join(""),
  ["resume", "Background", "Child", "Run"].join(""),
  ["Background", "Child", "Agent"].join(""),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
  ["background", "Subagents"].join(""),
  ["background", "subagent"].join("-"),
  ["subagent", "job", "start"].join("-"),
  ["subagent", "job", "update"].join("-"),
  ["subagent", "job", "end"].join("-"),
  ["create", "Subagent", "Tools"].join(""),
  ["register", "Subagents"].join(""),
];
