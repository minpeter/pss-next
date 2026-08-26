import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config } from "dotenv";
import type { CodingAgentRuntimeEnv } from "./env";
import { runCodingAgentExec } from "./exec";
import {
  importCliExtensions,
  mergeCliExtensions,
  resolveCliExtensionTargets,
} from "./extensions/manager/cli-extensions";
import { loadConfiguredCodingAgentExtensions } from "./extensions/manager/loader";
import {
  createProviderObservationFetch,
  type ProviderObservationEmitter,
} from "./provider-observation";
import { createProviderModelFromEnv } from "./provider-registry";
import type { WebToolsAvailability } from "./tools";

interface ExecArguments {
  readonly baseUrl?: string;
  readonly extensionPaths: readonly string[];
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
  extensionPaths: string[];
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

class ExecOptionError extends Error {
  readonly name = "ExecOptionError";

  constructor() {
    super("Invalid pss exec option.");
  }
}

const VALUE_FLAGS = new Set([
  "--base-url",
  "--extension",
  "--model",
  "--prompt",
  "--prompt-file",
  "--result-file",
  "--timeout-seconds",
  "--web-tools",
  "--workspace",
]);

function requiredValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ExecOptionError();
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
    case "--extension":
      options.extensionPaths.push(value);
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
        throw new ExecOptionError();
      }
      options.webToolsAvailability = value;
      return;
    default:
      throw new ExecOptionError();
  }
}

function validateArguments(options: ExecArguments): void {
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds <= 0 ||
    options.timeoutSeconds > 1200
  ) {
    throw new ExecOptionError();
  }
  const promptSources =
    Number(options.prompt !== undefined) +
    Number(options.promptFile !== undefined) +
    Number(options.readStdin);
  if (!options.help && promptSources !== 1) {
    throw new ExecOptionError();
  }
}

export function parseExecArguments(
  argv: readonly string[],
  cwd = process.cwd()
): ExecArguments {
  const options: MutableExecArguments = {
    extensionPaths: [],
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
    const valueFlag = flag === "-e" ? "--extension" : flag;
    if (!VALUE_FLAGS.has(valueFlag)) {
      throw new ExecOptionError();
    }
    setValueOption(options, valueFlag, requiredValue(argv, index), cwd);
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
    "                [-e|--extension <path>]...",
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
  const cliTargets = await resolveCliExtensionTargets({
    cwd,
    paths: args.extensionPaths,
  });
  const excludeIds = new Set(cliTargets.map((target) => target.id));
  const configured = await loadConfiguredCodingAgentExtensions({
    cwd: args.workspace,
    ...(excludeIds.size === 0 ? {} : { excludeIds }),
    home,
  });
  for (const notice of configured.notices) {
    stdout.write(
      `${JSON.stringify({ message: notice, type: "extension_notice" })}\n`
    );
  }
  const extensions =
    cliTargets.length === 0
      ? configured.extensions
      : mergeCliExtensions(
          configured.extensions,
          await importCliExtensions({ targets: cliTargets })
        );
  const providerEmitter: ProviderObservationEmitter = {};
  const result = await runCodingAgentExec({
    bindProviderObservation: (emit) => {
      providerEmitter.current = emit;
    },
    extensions,
    home,
    model: await createProviderModelFromEnv({
      fetch: createProviderObservationFetch(providerEmitter),
      runtimeEnv,
    }),
    prompt,
    ...(args.resultFile === undefined ? {} : { resultFile: args.resultFile }),
    stdout,
    timeoutMs: args.timeoutSeconds * 1000,
    webToolsAvailability: args.webToolsAvailability,
    workspace: args.workspace,
  });
  return result.status === "completed" ? 0 : 1;
}
