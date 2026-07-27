import { fileURLToPath } from "node:url";
import { runWithDefinition } from "@vercel/agent-eval/dist/lib/agents/plugin/orchestrator.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./constants.mjs";

function createPssDefinition() {
  return {
    name: "pss",
    displayName: "PSS",
    defaultModel: DEFAULT_MODEL,
    // NOTE: agent-eval ships a closed parser registry (claude-code, codex,
    // cursor, gemini, opencode); "pss" has no parser, so the injected o11y
    // summary is empty (parseSuccess: false). Scoring is unaffected: it
    // reads transcript-raw.jsonl directly (see scoring.mjs).
    o11yAgentName: "pss",
    runnerPath: fileURLToPath(new URL("./sandbox-runner.mjs", import.meta.url)),
    getApiKeyEnvVar() {
      return "AI_API_KEY";
    },
    install() {
      return [
        {
          kind: "command",
          cmd: "npm",
          args: ["install"],
          retryOnce: true,
          errorPrefix: "Project dependency install failed",
          errorBody: "last10",
        },
        {
          kind: "command",
          cmd: "npm",
          args: ["install", "-g", "/tmp/pss-coding-agent.tgz"],
          errorPrefix: "PSS install failed",
          errorBody: "stderr",
        },
      ];
    },
    configFiles() {
      return [];
    },
    authEnv(options) {
      return {
        AI_API_KEY: options.apiKey,
        AI_BASE_URL: options.agentOptions?.baseUrl ?? DEFAULT_BASE_URL,
        PSS_DISABLE_UPDATE_CHECK: "1",
      };
    },
    runnerExtra(options) {
      return {
        timeoutSeconds: Math.max(1, Math.floor(options.timeout / 1000)),
      };
    },
  };
}

export function createPssAgent() {
  const definition = createPssDefinition();
  return {
    name: definition.name,
    displayName: definition.displayName,
    getApiKeyEnvVar: definition.getApiKeyEnvVar,
    getDefaultModel() {
      return definition.defaultModel;
    },
    run: (fixturePath, options) =>
      runWithDefinition(definition, fixturePath, options),
    definition,
  };
}
