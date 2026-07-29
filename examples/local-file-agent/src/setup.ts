import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env", quiet: true, override: true });

const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M3"),
    PSS_EXAMPLE_THREAD_DIR: z
      .string()
      .trim()
      .min(1)
      .default(".pss-local-threads"),
    PSS_EXAMPLE_THREAD_KEY: z.string().trim().min(1).default("default"),
  },
});

const provider = createOpenAICompatible({
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
  name: "custom",
});

export const thread = (
  await createAgent({
    host: createFileHost({ directory: env.PSS_EXAMPLE_THREAD_DIR }),
    instructions: "Answer briefly and remember useful context in the thread.",
    model: provider(env.AI_MODEL),
  })
).thread(env.PSS_EXAMPLE_THREAD_KEY);
