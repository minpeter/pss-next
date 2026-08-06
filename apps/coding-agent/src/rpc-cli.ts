import { homedir } from "node:os";
import { resolve } from "node:path";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";
import { servePssProtocol } from "@minpeter/pss-runtime/protocol";
import { config } from "dotenv";
import { createCodingAgent } from "./coding-agent";
import type { CodingAgentRuntimeEnv } from "./env";
import { createOpenAICompatibleModelFromEnv } from "./model";
import { createCodingAgentRpcSession } from "./rpc";
import { resolveCodingAgentThreadConfig } from "./thread-config";

interface RunRpcCliOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: CodingAgentRuntimeEnv;
  readonly home?: string;
  readonly stdin?: AsyncIterable<string | Uint8Array>;
  readonly stdout?: { write(text: string): unknown };
}

export async function runRpcCli({
  argv,
  cwd,
  env,
  home = homedir(),
  stdin = process.stdin,
  stdout = process.stdout,
}: RunRpcCliOptions): Promise<number> {
  const args = parseRpcArguments(argv, cwd);
  if (args.help) {
    // Help is intentionally stderr-only: stdout is reserved for JSONL frames.
    process.stderr.write(`${formatRpcUsage()}\n`);
    return 0;
  }
  config({ override: false, path: resolve(cwd, ".env"), quiet: true });
  const runtimeEnv = {
    ...process.env,
    ...env,
    ...(args.baseUrl ? { AI_BASE_URL: args.baseUrl } : {}),
    ...(args.model ? { AI_MODEL: args.model } : {}),
  };
  const threadConfig = resolveRpcThreadConfig(runtimeEnv, args.workspace, home);
  const threadKey = args.session ?? threadConfig.key;
  const agent = await createCodingAgent({
    compaction: threadConfig.compaction,
    host: createFileHost({ directory: threadConfig.directory }),
    model: createOpenAICompatibleModelFromEnv({ runtimeEnv }),
    workspace: args.workspace,
  });
  const session = createCodingAgentRpcSession(agent.thread(threadKey), {
    threadKey,
  });
  try {
    await servePssProtocol(
      {
        readable: stdin,
        write: (data) => {
          stdout.write(data);
        },
      },
      session.handler
    );
    await session.settled;
    return 0;
  } finally {
    await agent.dispose();
  }
}

export function resolveRpcThreadConfig(
  env: CodingAgentRuntimeEnv,
  workspace: string,
  home: string
) {
  return resolveCodingAgentThreadConfig(env, workspace, home);
}

function parseRpcArguments(
  argv: readonly string[],
  cwd: string
): {
  baseUrl?: string;
  help: boolean;
  model?: string;
  session?: string;
  workspace: string;
} {
  const result: {
    baseUrl?: string;
    help: boolean;
    model?: string;
    session?: string;
    workspace: string;
  } = { help: false, workspace: cwd };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      result.help = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`${flag} requires a value.`);
    }
    if (flag === "--workspace") {
      result.workspace = resolve(cwd, value);
    } else if (flag === "--session") {
      result.session = value;
    } else if (flag === "--model") {
      result.model = value;
    } else if (flag === "--base-url") {
      result.baseUrl = value;
    } else {
      throw new Error(`Unknown pss rpc option: ${flag}`);
    }
    index += 2;
  }
  return result;
}

export function formatRpcUsage(): string {
  return "Usage: pss rpc [--workspace <dir>] [--session <key>] [--model <id>] [--base-url <url>]";
}
