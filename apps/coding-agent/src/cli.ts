import { homedir } from "node:os";
import { dirname } from "node:path";
import { runExecCli } from "./exec-cli";
import { runExtensionCli } from "./extension-cli";
import type {
  CodingAgentExtensionInput,
  LoadedConfiguredExtensions,
} from "./extensions";
import {
  importCliExtensions,
  mergeCliExtensions,
  resolveCliExtensionTargets,
} from "./extensions/manager/cli-extensions";
import { loadConfiguredCodingAgentExtensions } from "./extensions/manager/loader";
import { extensionScopePaths } from "./extensions/manager/paths";
import { beginCommonJsReloadTransaction } from "./extensions/manager/reload-module-graph";
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

  if (command === undefined || isExtensionFlag(command)) {
    return await runTuiCommand({
      argv,
      cwd,
      home,
      ...(loadExtensions === undefined ? {} : { loadExtensions }),
      ...(start === undefined ? {} : { start }),
      stdout,
    });
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

async function runTuiCommand({
  argv,
  cwd,
  home,
  loadExtensions,
  start,
  stdout,
}: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly home: string;
  readonly loadExtensions?: () => Promise<LoadedConfiguredExtensions>;
  readonly start?: (
    extensions: readonly CodingAgentExtensionInput[]
  ) => Promise<number>;
  readonly stdout: { write(text: string): void };
}): Promise<number> {
  let extensionPaths: readonly string[];
  try {
    extensionPaths = parseTuiExtensionPaths(argv);
  } catch (error) {
    stdout.write(`${errorMessage(error)}\n\n${formatUsage()}\n`);
    return 1;
  }
  let cliTargets: Awaited<ReturnType<typeof resolveCliExtensionTargets>>;
  try {
    cliTargets = await resolveCliExtensionTargets({
      cwd,
      paths: extensionPaths,
    });
  } catch (error) {
    stdout.write(`${errorMessage(error)}\n`);
    return 1;
  }
  const excludeIds = new Set(cliTargets.map((target) => target.id));
  const configured =
    (await loadExtensions?.()) ??
    (start
      ? { extensions: [], notices: [] }
      : await loadConfiguredCodingAgentExtensions({
          cwd,
          ...(excludeIds.size === 0 ? {} : { excludeIds }),
          home,
        }));
  for (const notice of configured.notices) {
    stdout.write(`${notice}\n`);
  }
  let extensions = configured.extensions;
  if (cliTargets.length > 0) {
    try {
      extensions = mergeCliExtensions(
        configured.extensions,
        await importCliExtensions({ targets: cliTargets })
      );
    } catch (error) {
      stdout.write(`${errorMessage(error)}\n`);
      return 1;
    }
  }
  const reloadExtensions = async (): Promise<
    LoadedConfiguredExtensions & { rollbackModuleCache(): void }
  > => {
    const cacheBust = Date.now().toString(36);
    const targets = await resolveCliExtensionTargets({
      cwd,
      paths: extensionPaths,
    });
    const targetIds = new Set(targets.map((target) => target.id));
    // Evict extension-owned CommonJS modules so cache-busted imports
    // re-execute helpers; the snapshot restores them if the reload fails.
    const transaction = beginCommonJsReloadTransaction(
      await reloadCacheRoots({ cwd, home, targets })
    );
    try {
      const reloaded = await loadConfiguredCodingAgentExtensions({
        cacheBust,
        cwd,
        ...(targetIds.size === 0 ? {} : { excludeIds: targetIds }),
        home,
      });
      return {
        extensions: mergeCliExtensions(
          reloaded.extensions,
          await importCliExtensions({ cacheBust, targets })
        ),
        notices: reloaded.notices,
        rollbackModuleCache: () => transaction.rollback(),
      };
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  };
  return await (
    start ??
    ((loaded: readonly CodingAgentExtensionInput[]) =>
      startTui({ extensions: loaded, reloadExtensions }))
  )(extensions);
}

async function reloadCacheRoots({
  cwd,
  home,
  targets,
}: {
  readonly cwd: string;
  readonly home: string;
  readonly targets: readonly { readonly path: string }[];
}): Promise<readonly string[]> {
  const roots = [
    (await extensionScopePaths({ cwd, home, scope: "global" })).installRoot,
    ...targets.map((target) => dirname(target.path)),
  ];
  try {
    roots.push(
      (await extensionScopePaths({ cwd, home, scope: "project" })).installRoot
    );
  } catch {
    // Untrusted or malformed project layouts simply contribute no root.
  }
  return roots;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExtensionFlag(value: string): boolean {
  return value === "-e" || value === "--extension";
}

function parseTuiExtensionPaths(argv: readonly string[]): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (!isExtensionFlag(flag)) {
      throw new Error(`Unknown pss option: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`${flag} requires a path value.`);
    }
    paths.push(value);
    index += 1;
  }
  return paths;
}

function formatUsage(): string {
  return [
    "Usage: pss [command] [-e <path>]",
    "",
    "Commands:",
    "  (no command)     Start the interactive TUI",
    "                   (-e/--extension <path> loads an extension for this run)",
    "  exec             Run one headless coding task",
    "  extension        Manage coding-agent extensions",
    "  inspect-thread   Print a report for the configured thread",
    "  update           Update pss (--check, --channel <tag>)",
    "  help             Show this help message",
  ].join("\n");
}
