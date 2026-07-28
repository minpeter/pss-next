import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentOptions } from "@minpeter/pss-runtime";

export interface CodingAgentThreadConfig {
  readonly autoCompaction: AgentOptions["autoCompaction"];
  readonly directory: string;
  readonly key: string;
  /** True when PSS_THREAD_KEY forced the key (session index is bypassed). */
  readonly keyFromEnv: boolean;
}

export function resolveCodingAgentThreadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = homedir()
): CodingAgentThreadConfig {
  const envKey = nonEmpty(env.PSS_THREAD_KEY);
  return {
    autoCompaction: resolveAutoCompaction(env),
    directory: nonEmpty(env.PSS_THREAD_DIR) ?? join(home, ".pss", "threads"),
    key: envKey ?? `cwd:${cwd}`,
    keyFromEnv: envKey !== undefined,
  };
}

function resolveAutoCompaction(
  env: NodeJS.ProcessEnv
): AgentOptions["autoCompaction"] {
  const contextWindow = nonEmpty(env.PSS_MODEL_CONTEXT_WINDOW);
  if (contextWindow === undefined) {
    return;
  }

  const maxInputTokens = Number(contextWindow);
  if (!(Number.isInteger(maxInputTokens) && maxInputTokens > 0)) {
    throw new Error("PSS_MODEL_CONTEXT_WINDOW must be a positive integer.");
  }

  return { maxInputTokens };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
