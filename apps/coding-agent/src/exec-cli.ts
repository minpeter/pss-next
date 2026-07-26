import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config } from "dotenv";
import type { CodingAgentRuntimeEnv } from "./env";
import { runCodingAgentExec } from "./exec";
import { loadConfiguredCodingAgentExtensions } from "./extensions/manager/loader";
import { createOpenAICompatibleModelFromEnv } from "./model";
import type { WebToolsAvailability } from "./tools";

interface ExecArguments {
  readonly baseUrl?: string;
  readonly help: boolean;
  readonly model?: string;
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly readStdin: boolean;
  readonly resultFile?: string;
  readonly timeoutSeconds: number;
  readonly webToolsAvailability: WebToolsAvailability;
  readonly workspace: string;
}

interface MutableExecArguments {
  baseUrl?: string;
  help: boolean;
  model?: string;
  prompt?: string;
  promptFile?: string;
  readStdin: boolean;
  resultFile?: string;
  timeoutSeconds: number;
  webToolsAvailability: WebToolsAvailability;
  workspace: string;
}

interface RunExecCliOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: CodingAgentRuntimeEnv;
  readonly home?: string;
  readonly stdout: { write(text: string): unknown };
}

const VALUE_FLAGS = new Set([
  "--base-url",
  "--model",
  "--prompt",
  "--prompt-file",
  "--result-file",
  "--timeout-seconds",
  "--web-tools",
  "--workspace",
]);

function requiredValue(
  argv: readonly string[],
  index: number,
  flag: string
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function setValueOption(
  options: MutableExecArguments,
  flag: string,
  value: string,
  cwd: string
): void {
  switch (flag) {
    case "--workspace":
      options.workspace = resolve(cwd, value);
      return;
    case "--prompt":
      options.prompt = value;
      return;
    case "--prompt-file":
      options.promptFile = value;
      return;
    case "--model":
      options.model = value;
      return;
    case "--base-url":
      options.baseUrl = value;
      return;
    case "--result-file":
      options.resultFile = resolve(cwd, value);
      return;
    case "--timeout-seconds":
      options.timeoutSeconds = Number(value);
      return;
    case "--web-tools":
      if (
        value !== "disabled" &&
        value !== "optional" &&
        value !== "required"
      ) {
        throw new Error(`Invalid --web-tools value: ${value}`);
      }
      options.webToolsAvailability = value;
      return;
    default:
      throw new Error(`Unknown pss exec option: ${flag}`);
  }
}

function validateArguments(options: ExecArguments): void {
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds <= 0 ||
    options.timeoutSeconds > 1200
  ) {
    throw new Error("--timeout-seconds must be an integer from 1 to 1200.");
  }
  const promptSources =
    Number(options.prompt !== undefined) +
    Number(options.promptFile !== undefined) +
    Number(options.readStdin);
  if (!options.help && promptSources !== 1) {
    throw new Error(
      "Choose exactly one of --prompt, --prompt-file, or --stdin."
    );
  }
}

export function parseExecArguments(
  argv: readonly string[],
  cwd = process.cwd()
): ExecArguments {
  const options: MutableExecArguments = {
    help: false,
    readStdin: false,
    timeoutSeconds: 1200,
    webToolsAvailability: "disabled",
    workspace: cwd,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (flag === "--stdin") {
      options.readStdin = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown pss exec option: ${flag}`);
    }
    setValueOption(options, flag, requiredValue(argv, index, flag), cwd);
    index += 1;
  }
  validateArguments(options);
  return options;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function formatExecUsage(): string {
  return [
    "Usage: pss exec --workspace <dir> (--prompt <text> | --prompt-file <file> | --stdin)",
    "                [--model <id>] [--base-url <url>] [--timeout-seconds <1-1200>]",
    "                [--web-tools disabled|optional|required] [--result-file <file>]",
  ].join("\n");
}

export async function runExecCli({
  argv,
  cwd,
  env,
  home = homedir(),
  stdout,
}: RunExecCliOptions): Promise<number> {
  const args = parseExecArguments(argv, cwd);
  if (args.help) {
    stdout.write(`${formatExecUsage()}\n`);
    return 0;
  }
  config({ override: false, path: resolve(cwd, ".env"), quiet: true });
  const runtimeEnv: CodingAgentRuntimeEnv = {
    ...process.env,
    ...env,
    ...(args.baseUrl === undefined ? {} : { AI_BASE_URL: args.baseUrl }),
    ...(args.model === undefined ? {} : { AI_MODEL: args.model }),
  };
  const prompt =
    args.prompt ??
    (args.promptFile === undefined
      ? await readAllStdin()
      : await readFile(resolve(cwd, args.promptFile), "utf8"));
  const configured = await loadConfiguredCodingAgentExtensions({
    cwd: args.workspace,
    home,
  });
  for (const notice of configured.notices) {
    stdout.write(
      `${JSON.stringify({ message: notice, type: "extension_notice" })}\n`
    );
  }
  const result = await runCodingAgentExec({
    extensions: configured.extensions,
    model: createOpenAICompatibleModelFromEnv({ runtimeEnv }),
    prompt,
    ...(args.resultFile === undefined ? {} : { resultFile: args.resultFile }),
    stdout,
    timeoutMs: args.timeoutSeconds * 1000,
    webToolsAvailability: args.webToolsAvailability,
    workspace: args.workspace,
  });
  return result.status === "completed" ? 0 : 1;
}
