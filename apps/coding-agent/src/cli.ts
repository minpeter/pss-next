import { homedir } from "node:os";
import { runExecCli } from "./exec-cli";
import { runExtensionCli } from "./extension-cli";
import type {
  CodingAgentExtensionInput,
  LoadedConfiguredExtensions,
} from "./extensions";
import { loadConfiguredCodingAgentExtensions } from "./extensions/manager/loader";
import { resolveCodingAgentThreadConfig } from "./thread-config";
import {
  formatThreadInspectionReport,
  inspectCodingAgentThread,
} from "./thread-inspect";
import { startTui } from "./tui/app";
import { cliVersion } from "./update/cli-version";
import { runUpdateCommand } from "./update/command";

interface RunCodingAgentCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly env?: Parameters<typeof resolveCodingAgentThreadConfig>[0];
  readonly exec?: (args: readonly string[]) => Promise<number>;
  readonly extension?: (args: readonly string[]) => Promise<number>;
  readonly home?: string;
  readonly loadExtensions?: () => Promise<LoadedConfiguredExtensions>;
  readonly start?: (
    extensions: readonly CodingAgentExtensionInput[]
  ) => Promise<number>;
  readonly stdout?: { write(text: string): void };
  readonly update?: (args: readonly string[]) => Promise<number>;
}

export async function runCodingAgentCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  exec,
  extension,
  loadExtensions,
  home = homedir(),
  start,
  stdout = process.stdout,
  update = (args: readonly string[]) =>
    runUpdateCommand({
      args,
      stdout,
      env,
      version: cliVersion,
      binPath: process.argv[1] ?? "",
      platform: process.platform,
    }),
}: RunCodingAgentCliOptions = {}): Promise<number> {
  const command = argv[0];

  if (command === undefined) {
    const configured =
      (await loadExtensions?.()) ??
      (start
        ? { extensions: [], notices: [] }
        : await loadConfiguredCodingAgentExtensions({ cwd, home }));
    for (const notice of configured.notices) {
      stdout.write(`${notice}\n`);
    }
    return await (
      start ??
      ((extensions: readonly CodingAgentExtensionInput[]) =>
        startTui({ extensions }))
    )(configured.extensions);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  if (command === "exec") {
    return (
      exec ??
      ((args: readonly string[]) =>
        runExecCli({ argv: args, cwd, env, home, stdout }))
    )(argv.slice(1));
  }

  if (command === "extension") {
    return (
      extension ??
      ((args: readonly string[]) =>
        runExtensionCli({ argv: args, cwd, home, stdout }))
    )(argv.slice(1));
  }

  if (command === "inspect-thread") {
    const config = resolveCodingAgentThreadConfig(env, cwd, home);
    const report = await inspectCodingAgentThread(config);
    stdout.write(`${formatThreadInspectionReport(report)}\n`);
    return 0;
  }

  if (command === "update") {
    return update(argv.slice(1));
  }

  stdout.write(`Unknown pss command: ${command}\n\n${formatUsage()}\n`);
  return 1;
}

function formatUsage(): string {
  return [
    "Usage: pss [command]",
    "",
    "Commands:",
    "  (no command)     Start the interactive TUI",
    "  exec             Run one headless coding task",
    "  extension        Manage coding-agent extensions",
    "  inspect-thread   Print a report for the configured thread",
    "  update           Update pss (--check, --channel <tag>)",
    "  help             Show this help message",
  ].join("\n");
}
