// Real model used when PSS_EVAL_REAL=1. Env validation is deferred to the
// first call so importing this module (in scripted mode) never fails without a
// key. `pnpm eval` defaults to scripted; `PSS_EVAL_REAL=1 pnpm eval` runs these
// exact evals against your real model.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env", quiet: true, override: true });

let cached: ReturnType<ReturnType<typeof createOpenAICompatible>> | undefined;

export function realModel() {
  if (cached) {
    return cached;
  }
  const env = createEnv({
    runtimeEnv: process.env,
    server: {
      AI_API_KEY: z.string().trim().min(1),
      AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
      AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M3"),
    },
  });
  cached = createOpenAICompatible({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    name: "custom",
  })(env.AI_MODEL);
  return cached;
}
