import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type AgentHooks, createAgent } from "@minpeter/pss-runtime";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env", quiet: true, override: true });
const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M2.7"),
  },
});

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});
const hooks: AgentHooks = {
  acceptInput(event) {
    if (event.type !== "user-input" || !("text" in event)) {
      return;
    }
    return {
      action: "transform",
      value: { ...event, text: `[host] ${event.text}` },
    };
  },
};

const agent = await createAgent({
  model: provider(env.AI_MODEL),
  hooks,
  instructions: "Answer briefly.",
});

const run = await agent.send(
  "Summarize in one sentence: hosts can intercept runtime boundaries."
);

for await (const event of run.events()) {
  console.log(event);
}
