import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { WorkerAgentModelEnv } from "../agent/agent";
import type { ChannelAddress } from "../channel";
import { WORKER_AGENT_TUI_CHANNEL } from "./tui-sink";

const TuiEnvironmentSchema = z.looseObject({
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_MODEL: z.string().optional(),
  WORKER_AGENT_TUI_CHANNEL_ID: z.string().optional(),
  WORKER_AGENT_TUI_DIR: z.string().optional(),
  WORKER_AGENT_TUI_ENDPOINT: z.url().trim().optional(),
  WORKER_AGENT_TUI_TOKEN: z.string().optional(),
});

export type WorkerAgentTuiConfig =
  | WorkerAgentLocalTuiConfig
  | WorkerAgentRemoteTuiConfig;

interface WorkerAgentLocalTuiConfig {
  readonly channel: ChannelAddress;
  readonly directory: string;
  readonly env: WorkerAgentModelEnv;
  readonly mode: "local";
}

interface WorkerAgentRemoteTuiConfig {
  readonly channel: ChannelAddress;
  readonly endpoint: string;
  readonly mode: "remote";
  readonly token?: string;
}

export function resolveWorkerAgentTuiConfig(
  environment: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2)
): WorkerAgentTuiConfig {
  const parsed = TuiEnvironmentSchema.parse(environment);
  const remoteEndpoint = readRemoteEndpoint(
    parsed.WORKER_AGENT_TUI_ENDPOINT,
    args
  );
  const channel = {
    id:
      parsed.WORKER_AGENT_TUI_CHANNEL_ID?.trim() || WORKER_AGENT_TUI_CHANNEL.id,
    kind: "tui",
  } satisfies ChannelAddress;

  if (remoteEndpoint) {
    return {
      channel,
      endpoint: remoteEndpoint,
      mode: "remote",
      ...(parsed.WORKER_AGENT_TUI_TOKEN?.trim()
        ? { token: parsed.WORKER_AGENT_TUI_TOKEN.trim() }
        : {}),
    };
  }

  const apiKey = parsed.AI_API_KEY?.trim();
  if (!apiKey) {
    throw new WorkerAgentTuiConfigError(
      "AI_API_KEY is required for local TUI mode. Set WORKER_AGENT_TUI_ENDPOINT or pass --remote for remote mode."
    );
  }

  return {
    channel,
    directory:
      parsed.WORKER_AGENT_TUI_DIR?.trim() ||
      join(homedir(), ".pss-next", "worker-agent-tui"),
    env: {
      AI_API_KEY: apiKey,
      ENVIRONMENT: "development",
      ...(parsed.AI_BASE_URL?.trim()
        ? { AI_BASE_URL: parsed.AI_BASE_URL.trim() }
        : {}),
      ...(parsed.AI_MODEL?.trim() ? { AI_MODEL: parsed.AI_MODEL.trim() } : {}),
    },
    mode: "local",
  };
}

function readRemoteEndpoint(
  environmentValue: string | undefined,
  args: readonly string[]
): string | undefined {
  const flagValue = args.find((arg) => arg.startsWith("--remote="));
  if (flagValue) {
    return flagValue.slice("--remote=".length).trim();
  }

  const remoteFlagIndex = args.indexOf("--remote");
  const remoteArgValue =
    remoteFlagIndex >= 0 ? args[remoteFlagIndex + 1]?.trim() : undefined;
  return remoteArgValue || environmentValue?.trim();
}

export class WorkerAgentTuiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAgentTuiConfigError";
  }
}
