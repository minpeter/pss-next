import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Agent, ThreadHandle } from "@minpeter/pss-runtime";
import { parentThreadNamespace } from "@minpeter/pss-runtime/namespace";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { createCoordinatorAgent, createReaderAgent } from "./agents";
import { createAppAgent } from "./app-agent-factory";
import { type LocalHost, localHost } from "./local-host";

loadEnv({ path: ".env", quiet: true, override: true });

const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M3"),
  },
});

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});
const model = provider(env.AI_MODEL);

export interface ExampleRuntime {
  readonly coordinator: Agent;
  readonly host: LocalHost;
  readonly reader: Agent;
  readonly thread: ThreadHandle;
  readonly threadKey: string;
}

export async function createExampleRuntime(
  threadKey = "default"
): Promise<ExampleRuntime> {
  let coordinator!: Agent;
  let reader!: Agent;
  const coordinatorNamespace = "coordinator";
  const ownerNamespace = parentThreadNamespace(coordinatorNamespace, threadKey);

  const host = localHost({
    agent: () =>
      createAppAgent({
        coordinator,
        host,
        ownerNamespace,
        parentThreadKey: threadKey,
        reader,
      }),
  });

  reader = await createReaderAgent(model, host);
  coordinator = await createCoordinatorAgent(model, {
    executionHost: host,
    host,
    threadKey,
  });

  return {
    coordinator,
    host,
    reader,
    threadKey,
    thread: coordinator.thread(threadKey),
  };
}
