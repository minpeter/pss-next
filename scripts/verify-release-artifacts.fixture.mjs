import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const cliBinReadFailurePattern =
  /^apps\/coding-agent\/bin\/pss\.js: cannot read CLI bin target /;
export const forbiddenModelName = ["Agent", "Model"].join("");
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
export const runtimeCloudflareWorkerDeclaration = [
  'export { ackScheduledCloudflareRun, ackScheduledCloudflareThreadPrompt, createCloudflareHost, createCloudflareStorageHost, createCloudflareScheduledWorkScheduler, drainAgentTurn, drainAgentTurnWithBudget, fetchCloudflareDurableObject, getCloudflareDurableObjectStub, InMemoryCloudflareDurableObjectStorage, listScheduledCloudflareRuns, listScheduledCloudflareThreadPrompts } from "./index";',
  'export type { AgentTurnDrainResult, AgentTurnDrainStopReason, CloudflareAgentTurnDrainOptions, CloudflareDurableObjectFetchOptions, CloudflareDurableObjectId, CloudflareDurableObjectNamespace, CloudflareDurableObjectState, CloudflareDurableObjectStorage, CloudflareDurableObjectStub, CloudflareDurableObjectStubOptions, CloudflareHostOptions, CloudflareScheduledThreadPrompt, CloudflareStorageHostOptions } from "./index";',
  "",
].join("\n");
export const runtimeCloudflareAgentsDeclaration = [
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

let tempRoots = [];

export function createTrackedTempRoot(prefix) {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(cwd);
  return cwd;
}

export function createFixture() {
  const cwd = createTrackedTempRoot("pss-release-artifacts-");

  for (const packageName of ["runtime", "extension-latex", "coding-agent"]) {
    const packageRoot = fixturePackageRoot(cwd, packageName);
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "dist", "index.js"),
      "export const ok = true;\n"
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify(packageMetadata(packageName), null, 2)
    );
    writePackageDeclarationFixtures(cwd, packageName, packageRoot);
  }

  return cwd;
}

export function cleanupFixtures() {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  tempRoots = [];
}

function packageMetadata(packageName) {
  return packageName === "coding-agent"
    ? {
        bin: {
          pss: "./bin/pss.js",
          "pss-coding-agent": "./bin/pss.js",
        },
      }
    : {};
}

function fixturePackageRoot(cwd, packageName) {
  if (packageName === "coding-agent") {
    return join(cwd, "apps", "coding-agent");
  }
  if (packageName === "extension-latex") {
    return join(cwd, "extensions", "latex");
  }
  return join(cwd, "packages", packageName);
}

function writePackageDeclarationFixtures(cwd, packageName, packageRoot) {
  const declaration =
    packageName === "runtime"
      ? runtimeRootDeclaration
      : "export declare const ok: true;\n";
  writeFileSync(join(packageRoot, "dist", "index.d.ts"), declaration);

  if (packageName === "runtime") {
    writeRuntimeDeclarationFixtures(cwd, packageName);
    return;
  }
  if (packageName !== "coding-agent") {
    return;
  }

  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    join(packageRoot, "bin", "pss.js"),
    "#!/usr/bin/env node\nimport '../dist/tui.js';\n",
    { mode: 0o755 }
  );
  writeFileSync(
    join(packageRoot, "dist", "tui.js"),
    "export const ok = true;\n"
  );
}

function writeRuntimeDeclarationFixtures(cwd, packageName) {
  mkdirSync(join(cwd, "packages", packageName, "dist", "channel"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "channel", "index.d.ts"),
    runtimeChannelDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "execution"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "execution", "index.d.ts"),
    runtimeExecutionDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "platform", "memory"), {
    recursive: true,
  });
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "memory",
      "index.d.ts"
    ),
    runtimeMemoryDeclaration
  );
  mkdirSync(
    join(cwd, "packages", packageName, "dist", "platform", "cloudflare"),
    { recursive: true }
  );
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "cloudflare",
      "index.d.ts"
    ),
    runtimeCloudflareDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "platform", "file"), {
    recursive: true,
  });
  writeFileSync(
    join(
      cwd,
      "packages",
      packageName,
      "dist",
      "platform",
      "file",
      "index.d.ts"
    ),
    runtimeFileDeclaration
  );
  mkdirSync(join(cwd, "packages", packageName, "dist", "otel"), {
    recursive: true,
  });
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "otel", "index.d.ts"),
    runtimeOtelDeclaration
  );
  writeFileSync(
    join(cwd, "packages", packageName, "dist", "llm.d.ts"),
    "export declare const ok: true;\n"
  );
}
