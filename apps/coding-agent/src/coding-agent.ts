import {
  type AgentHooks,
  type AgentOptions,
  createAgent,
} from "@minpeter/pss-runtime";
import type { ToolSet } from "ai";
import { composeAgentHooks } from "./extensions/compose-hooks";
import type { CodingAgentExtensionHost } from "./extensions/host";
import { CODING_AGENT_INSTRUCTIONS } from "./instructions";
import { createCodingLanguageModel } from "./model";
import {
  type CreateCodingAgentToolsOptions,
  createCodingAgentTools,
} from "./tools";
import { createWorkspaceTools } from "./workspace-tools";

export interface CreateCodingAgentOptions {
  readonly autoCompaction?: AgentOptions["autoCompaction"];
  readonly extensionHost?: CodingAgentExtensionHost;
  readonly hooks?: AgentHooks;
  readonly host?: AgentOptions["host"];
  readonly instructions?: string;
  readonly model?: AgentOptions["model"];
  /**
   * Replaces the default optional web tools. Workspace tools are always
   * included and win name collisions, so custom tools cannot shadow them.
   * This factory always grants workspace file/shell access; build restricted
   * agents on `createAgent` from @minpeter/pss-runtime instead.
   */
  readonly tools?: ToolSet;
  readonly webTools?: CreateCodingAgentToolsOptions;
  readonly workspace?: string;
}

export function createCodingAgent({
  autoCompaction,
  extensionHost,
  host,
  hooks,
  instructions = CODING_AGENT_INSTRUCTIONS,
  model = createCodingLanguageModel(),
  tools,
  webTools,
  workspace = process.cwd(),
}: CreateCodingAgentOptions = {}) {
  extensionHost?.bindRuntimeServices({ model, workspace });
  const selectedTools = tools ?? createCodingAgentTools(webTools);
  const extensionTools = extensionHost?.tools ?? {};
  const workspaceTools = createWorkspaceTools({ workspace });
  assertNoToolCollisions(
    selectedTools,
    extensionTools,
    workspaceTools,
    extensionHost
  );
  const resolvedTools = {
    ...selectedTools,
    ...extensionTools,
    ...workspaceTools,
  } satisfies ToolSet;
  const instructionFragments = extensionHost?.instructionFragments ?? [];
  const extensionInstrumentations = extensionHost?.instrumentations ?? [];
  const hookRegistrations = [
    ...(hooks ? [{ extensionId: "coding-agent", hooks }] : []),
    ...(extensionHost?.hookRegistrations ?? []),
  ];

  return createAgent({
    ...(autoCompaction === undefined ? {} : { autoCompaction }),
    ...(host === undefined ? {} : { host }),
    hooks:
      hookRegistrations.length === 0
        ? undefined
        : composeAgentHooks(
            hookRegistrations,
            extensionHookOptions(extensionHost)
          ),
    instructions: [instructions, ...instructionFragments].join("\n\n"),
    instrumentations: extensionInstrumentations,
    model,
    ...(extensionHost
      ? { threadMigrations: extensionHost.threadMigrations }
      : {}),
    tools: resolvedTools,
  });
}

function extensionHookOptions(extensionHost?: CodingAgentExtensionHost): {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
} {
  if (extensionHost === undefined) {
    return {};
  }
  return { signal: extensionHost.signal, timeoutMs: extensionHost.timeoutMs };
}

function assertNoToolCollisions(
  selectedTools: ToolSet,
  extensionTools: ToolSet,
  workspaceTools: ToolSet,
  extensionHost?: CodingAgentExtensionHost
): void {
  for (const name of Object.keys(extensionTools)) {
    if (
      Object.hasOwn(selectedTools, name) ||
      Object.hasOwn(workspaceTools, name)
    ) {
      const owner = extensionHost?.getToolOwner(name) ?? "unknown";
      throw new Error(
        `Extension "${owner}" tool "${name}" conflicts with built-in tool`
      );
    }
  }
  for (const name of Object.keys(selectedTools)) {
    if (Object.hasOwn(workspaceTools, name)) {
      throw new Error(`Duplicate coding agent built-in tool "${name}"`);
    }
  }
}
