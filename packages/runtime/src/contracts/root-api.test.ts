import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentHost,
  CheckpointStore,
  EventStore,
  HostScheduler,
  HostStore,
  HostStoreTransaction,
  NotificationInbox,
  NotificationRecord,
  StoredThreadEvent,
  ThreadEventLog,
  ThreadEventReadOptions,
  TurnRecord,
  TurnStore,
} from "../execution";
import type {
  Agent,
  AgentAutoCompactionOptions,
  AgentEvent,
  AgentHooks,
  AgentInput,
  AgentInstrumentation,
  AgentInstrumentationContext,
  AgentInstrumentationOperation,
  AgentOptions,
  CompactionContextMessage,
  HostAttachmentStore,
  ModelToolCacheFingerprintMetadata,
  PrepareModelStep,
  PrepareModelStepInput,
  PrepareModelStepResult,
  StreamAgentEvent,
  ThreadCompactionInput,
  ThreadContextMessage,
  ThreadHandle,
} from "../index";
import {
  AgentHookError,
  createAgent,
  isStreamAgentEvent,
  ModelToolSelectionError,
  threadStoreKey as runtimeThreadStoreKey,
  ThreadEventReplayUnsupportedError,
} from "../index";
import type { TraceAgentTurnOptions } from "../otel";

type EmptyHostIsRejected =
  Record<string, never> extends AgentHost ? true : false;
const emptyHostIsRejected: EmptyHostIsRejected = false;
const forbiddenRuntimeSubagentExports = [
  ["Subagent", "Definition"].join(""),
  ["resume", "Background", "Child", "Run"].join(""),
  ["Background", "Child", "Agent"].join(""),
  ["Subagent", "Status", "Agent", "Event"].join(""),
  ["is", "Subagent", "Status", "Agent", "Event"].join(""),
] as const;
const forbiddenModelAdapterRootExports = [
  ["Runtime", "Create", "Llm", "Options"].join(""),
  ["Runtime", "Llm"].join(""),
  ["Runtime", "Llm", "Context"].join(""),
  ["Runtime", "Llm", "Output"].join(""),
  ["Runtime", "Llm", "Output", "Part"].join(""),
  ["create", "Llm"].join(""),
] as const;
const forbiddenChannelRootExports = [
  ["Channel", "Inbound", "Message"].join(""),
  ["Channel", "Assistant", "Text", "Delivery"].join(""),
  ["Channel", "Assistant", "Delivery"].join(""),
  ["project", "Channel", "Assistant", "Delivery"].join(""),
] as const;

describe("runtime public exports", () => {
  it("does not expose internal agent loop runner from package root", async () => {
    const runtime = await import("../index");

    expect(runtime).not.toHaveProperty("runAgentLoop");
  });

  it("keeps package root app-facing and omits run stream helpers", async () => {
    const runtime = await import("../index");
    const runStreamExport = ["Agent", "Run", "Stream"].join("");

    expect(runtime).toHaveProperty("createAgent", createAgent);
    expect(runtime).toHaveProperty("AgentHookError", AgentHookError);
    expect(runtime).not.toHaveProperty("definePlugin");
    expect(runtime).not.toHaveProperty("Agent");
    expect(runtime).not.toHaveProperty("tool");
    expect(runtime).not.toHaveProperty("runPluginsForEvent");
    expect(runtime).not.toHaveProperty("runPluginsForToolCall");
    expect(runtime).toHaveProperty("threadStoreKey", runtimeThreadStoreKey);
    expect(runtime).toHaveProperty("isStreamAgentEvent", isStreamAgentEvent);
    expectTypeOf<StreamAgentEvent["type"]>().toEqualTypeOf<
      | "assistant-output-delta"
      | "assistant-reasoning-delta"
      | "tool-call-input-delta"
      | "tool-call-input-end"
      | "tool-call-input-start"
    >();
    expect(runtime).not.toHaveProperty("createInMemoryHost");
    expect(runtime).not.toHaveProperty("createCloudflareHost");
    expect(runtime).not.toHaveProperty("createCloudflareStorageHost");
    expect(runtime).not.toHaveProperty("createCloudflarePlatformContext");
    expect(runtime).not.toHaveProperty("createFileHost");
    expect(runtime).not.toHaveProperty("createNodeFileAgentContext");
    expect(runtime).not.toHaveProperty("createFileHost");
    expect(runtime).not.toHaveProperty("FileExecutionStore");
    expect(runtime).not.toHaveProperty("FileThreadStore");
    expect(runtime).not.toHaveProperty("executionHost");
    expect(runtime).not.toHaveProperty("BackgroundScheduler");
    expect(runtime).not.toHaveProperty("ToolExecutionNeedsRecoveryError");
    expect(runtime).not.toHaveProperty(runStreamExport);
    expect(emptyHostIsRejected).toBe(false);
  });

  it("types the single host hook contract", () => {
    expectTypeOf<NonNullable<AgentHooks["acceptInput"]>>().toBeFunction();
    expectTypeOf<
      NonNullable<AgentHooks["beforeToolExecution"]>
    >().toBeFunction();
    expectTypeOf<keyof AgentHooks>().toEqualTypeOf<
      | "acceptInput"
      | "beforeCompaction"
      | "beforeToolExecution"
      | "beforeTurnStart"
      | "transformModelContext"
      | "transformModelStep"
      | "transformToolResult"
    >();
  });

  it("does not expose runtime-owned subagent helpers from the package root", async () => {
    const runtime = await import("../index");

    for (const forbiddenName of forbiddenRuntimeSubagentExports) {
      expect(runtime).not.toHaveProperty(forbiddenName);
    }
  });

  it("does not expose runtime LLM adapter names from the package root", async () => {
    const runtime = await import("../index");

    for (const forbiddenName of forbiddenModelAdapterRootExports) {
      expect(runtime).not.toHaveProperty(forbiddenName);
    }
  });

  it("keeps channel adapter contracts off the package root", async () => {
    const runtime = await import("../index");

    for (const forbiddenName of forbiddenChannelRootExports) {
      expect(runtime).not.toHaveProperty(forbiddenName);
    }
  });

  it("types public thread compaction options from the package root", () => {
    const autoCompaction = {
      contextGate: {
        maxInputTokens: 120_000,
        onOverflow: "compact",
      },
      minMessages: 12,
      retainMessages: 4,
    } satisfies AgentAutoCompactionOptions;
    const model = {} as AgentOptions["model"];
    const attachmentStore = {} as HostAttachmentStore;
    const instrumentation = {
      wrapTurn: (turn, context) => {
        expectTypeOf(context).toEqualTypeOf<AgentInstrumentationContext>();
        expectTypeOf(
          context.operation
        ).toEqualTypeOf<AgentInstrumentationOperation>();
        return turn;
      },
    } satisfies AgentInstrumentation;
    const enabledOptions = {
      attachmentStore,
      autoCompaction,
      instrumentations: [instrumentation],
      model,
      notificationOverlays: ["runtime context"],
    } satisfies AgentOptions;
    const disabledOptions = {
      autoCompaction: false,
      model,
    } satisfies AgentOptions;
    const compaction = {
      endSeqExclusive: 8,
      startSeq: 0,
      summary: "Earlier turns established the durable context.",
    } satisfies ThreadCompactionInput;
    const contextCompaction = {
      endSeqExclusive: 8,
      role: "compaction",
      startSeq: 0,
      summary: "Earlier turns established the durable context.",
    } satisfies CompactionContextMessage;

    expectTypeOf<
      Parameters<ThreadHandle["compact"]>[0]
    >().toEqualTypeOf<ThreadCompactionInput>();
    expectTypeOf<
      Parameters<
        NonNullable<AgentHooks["transformModelContext"]>
      >[0]["messages"]
    >().toEqualTypeOf<readonly ThreadContextMessage[]>();
    expectTypeOf<
      Parameters<ThreadHandle["overlay"]>[0]
    >().toEqualTypeOf<AgentInput>();
    expectTypeOf<
      ReturnType<ThreadHandle["overlay"]>
    >().toEqualTypeOf<ThreadHandle>();
    expectTypeOf<Parameters<ThreadHandle["events"]>[0]>().toEqualTypeOf<
      ThreadEventReadOptions | undefined
    >();
    expectTypeOf<ReturnType<ThreadHandle["events"]>>().toEqualTypeOf<
      AsyncIterable<StoredThreadEvent>
    >();
    expect(new ThreadEventReplayUnsupportedError("thread-1").name).toBe(
      "ThreadEventReplayUnsupportedError"
    );
    expectTypeOf<ReturnType<Agent["overlay"]>>().toEqualTypeOf<ThreadHandle>();
    expectTypeOf<
      ReturnType<typeof runtimeThreadStoreKey>
    >().toEqualTypeOf<string>();
    expect(enabledOptions.autoCompaction).toEqual(autoCompaction);
    expect(enabledOptions.attachmentStore).toBe(attachmentStore);
    expect(enabledOptions.instrumentations).toEqual([instrumentation]);
    expect(enabledOptions.notificationOverlays).toEqual(["runtime context"]);
    expect(disabledOptions.autoCompaction).toBe(false);
    expect(compaction.startSeq).toBe(0);
    expect(contextCompaction.role).toBe("compaction");
  });

  it("types OpenTelemetry adapter options from its subpath", () => {
    const options = {
      eventAttributes: (event: AgentEvent) => ({
        "app.event_type": event.type,
      }),
      tracerName: "support-agent",
    } satisfies TraceAgentTurnOptions;

    expect(options.tracerName).toBe("support-agent");
  });

  it("exports cache-stable model-step contracts from the package root", async () => {
    const runtime = await import("../index");
    expectTypeOf<PrepareModelStepInput["history"]>().toEqualTypeOf<
      readonly ThreadContextMessage[]
    >();
    const prepareModelStep: PrepareModelStep = (input) => {
      expectTypeOf(input).toEqualTypeOf<PrepareModelStepInput>();
      return { activeTools: [] } satisfies PrepareModelStepResult;
    };
    const asyncVoidCallback = (): Promise<void> => Promise.resolve();
    const asyncPrepareModelStep: PrepareModelStep = asyncVoidCallback;
    const model = {} as AgentOptions["model"];
    const options = {
      alwaysActiveTools: ["status"],
      model,
      prepareModelStep,
      toolOrder: ["status"],
    } satisfies AgentOptions;
    const metadata = {
      activeToolCount: 1,
      activeToolsFingerprint: "sha256:active",
      alwaysActiveToolCount: 1,
      attemptId: "attempt-1",
      dynamicDescriptionToolCount: 0,
      modelIdentityFingerprint: "sha256:model",
      modelIdentityFingerprintUnavailable: false,
      orderedToolSemanticFingerprint: "sha256:semantic",
      orderedToolNamesFingerprint: "sha256:order",
      registeredToolCount: 2,
      registryToolNamesFingerprint: "sha256:registry",
      runtimeStepIndex: 0,
      selectionDurationMs: 1,
      semanticFingerprintUnavailableToolCount: 0,
      toolLoadingStrategy: "eager-active-tools",
    } satisfies ModelToolCacheFingerprintMetadata;

    expect(runtime).toHaveProperty(
      "ModelToolSelectionError",
      ModelToolSelectionError
    );
    expect(options.prepareModelStep).toBe(prepareModelStep);
    expect(asyncPrepareModelStep).toBe(asyncVoidCallback);
    expect(metadata.runtimeStepIndex).toBe(0);
  });

  it("types advanced host contracts", () => {
    expectTypeOf<AgentHost["scheduler"]>().toEqualTypeOf<HostScheduler>();
    expectTypeOf<AgentHost["store"]>().toEqualTypeOf<HostStore>();
    expectTypeOf<
      HostStore["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<AgentHost["attachmentStore"]>().toEqualTypeOf<
      HostAttachmentStore | undefined
    >();
    expectTypeOf<HostStore["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<HostStore["checkpoints"]>().toEqualTypeOf<CheckpointStore>();
    expectTypeOf<HostStore["events"]>().toEqualTypeOf<EventStore>();
    expectTypeOf<HostStore["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<
      Parameters<NotificationInbox["enqueue"]>[0]
    >().toEqualTypeOf<NotificationRecord>();
    expectTypeOf<
      Awaited<ReturnType<TurnStore["get"]>>
    >().toEqualTypeOf<TurnRecord | null>();
    expectTypeOf<HostStoreTransaction["turns"]>().toEqualTypeOf<TurnStore>();
    expectTypeOf<
      HostStoreTransaction["notifications"]
    >().toEqualTypeOf<NotificationInbox>();
    expectTypeOf<HostStoreTransaction["threadEvents"]>().toEqualTypeOf<
      ThreadEventLog | undefined
    >();
    expectTypeOf<AgentHost>().not.toHaveProperty("kind");
  });

  it("exports file thread inspection from the file adapter only", async () => {
    const runtime = await import("../index");
    const fileAdapter = await import("../platform/file");

    expect(runtime).not.toHaveProperty("inspectFileThread");
    expect(runtime).not.toHaveProperty("fileThreadStorageHint");
    expect(fileAdapter).toHaveProperty("inspectFileThread");
    expect(fileAdapter).toHaveProperty("fileThreadStorageHint");
  });
});
