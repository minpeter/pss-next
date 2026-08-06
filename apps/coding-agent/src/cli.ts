import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { beginExtensionStagingSession } from "./extensions/manager/reload-staging";
import { readExtensionSettings } from "./extensions/manager/settings";
import { runRpcCli } from "./rpc-cli";
import {
  activeSessionKey,
  readSessionIndex,
  sessionIndexPath,
} from "./sessions/session-index";
import {
  type CodingAgentThreadConfig,
  resolveCodingAgentThreadConfig,
} from "./thread-config";
import {
  formatThreadInspectionReport,
  inspectCodingAgentThread,
} from "./thread-inspect";
import { startTui } from "./tui/app";
import { boundedReloadOperation } from "./tui/reload";
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
  readonly rpc?: (args: readonly string[]) => Promise<number>;
  readonly start?: (
    extensions: readonly CodingAgentExtensionInput[],
    selection: {
      readonly sessionKey?: string;
      readonly sessionName?: string;
    }
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
  rpc,
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

  if (command === undefined || isTuiFlag(command)) {
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

  if (command === "rpc") {
    return (
      rpc ??
      ((args: readonly string[]) => runRpcCli({ argv: args, cwd, env, home }))
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
    const report = await inspectCodingAgentThread({
      ...config,
      key: await resolveInspectionThreadKey(config, cwd),
    });
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
    extensions: readonly CodingAgentExtensionInput[],
    selection: {
      readonly sessionKey?: string;
      readonly sessionName?: string;
    }
  ) => Promise<number>;
  readonly stdout: { write(text: string): void };
}): Promise<number> {
  let extensionPaths: readonly string[];
  let selection: {
    readonly sessionKey?: string;
    readonly sessionName?: string;
  };
  try {
    ({ extensionPaths, ...selection } = parseTuiArguments(argv));
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
  const reloadExtensions = createTuiExtensionReloader({
    cwd,
    extensionPaths,
    home,
  });
  if (start !== undefined) {
    return await start(extensions, selection);
  }
  return await startTui({
    extensions,
    reloadExtensions,
    ...selection,
  });
}

/**
 * Build the `/reload` loader for a TUI session. Exported for tests: the
 * staged-then-commit ordering (worker staging before any main-context
 * import or CommonJS eviction) is the reload-isolation contract from #262.
 */
export function createTuiExtensionReloader({
  cwd,
  extensionPaths,
  home,
}: {
  readonly cwd: string;
  readonly extensionPaths: readonly string[];
  readonly home: string;
}): () => Promise<
  LoadedConfiguredExtensions & { rollbackModuleCache(): void }
> {
  return async () => {
    const cacheBust = Date.now().toString(36);
    const targets = await resolveCliExtensionTargets({
      cwd,
      paths: extensionPaths,
    });
    const targetIds = new Set(targets.map((target) => target.id));
    // Stage every candidate in an isolated worker module context first: a
    // candidate that fails to import (or exports the wrong shape) fails the
    // reload here, before the live runtime's module graph or CommonJS cache
    // is touched at all.
    const staging = beginExtensionStagingSession();
    const stagingAbort = new AbortController();
    try {
      await boundedReloadOperation(
        (async () => {
          await importCliExtensions({
            importer: staging.importer,
            signal: stagingAbort.signal,
            targets,
          });
          await loadConfiguredCodingAgentExtensions({
            cwd,
            ...(targetIds.size === 0 ? {} : { excludeIds: targetIds }),
            home,
            importer: staging.importer,
            signal: stagingAbort.signal,
          });
        })(),
        RELOAD_IMPORT_TIMEOUT_MS,
        "Extension reload staging"
      );
    } catch (error) {
      stagingAbort.abort();
      throw error;
    } finally {
      await staging.dispose();
    }
    // Refuse to disturb extension-owned process-wide CommonJS cache entries;
    // those extensions require a restart. ESM graphs remain reloadable.
    const transaction = beginCommonJsReloadTransaction(
      await reloadCacheRoots({ cwd, home, targets }),
      staging.commonJsPaths()
    );
    // Bound imports so an edited extension with a never-settling top-level
    // await fails the reload instead of freezing the session; the abort
    // signal stops the detached task from importing further modules after
    // the timeout so it cannot repopulate the rolled-back module cache.
    const importAbort = new AbortController();
    try {
      const { cliExtensions, reloaded } = await boundedReloadOperation(
        (async () => ({
          cliExtensions: await importCliExtensions({
            cacheBust,
            signal: importAbort.signal,
            targets,
          }),
          reloaded: await loadConfiguredCodingAgentExtensions({
            cacheBust,
            cwd,
            ...(targetIds.size === 0 ? {} : { excludeIds: targetIds }),
            home,
            signal: importAbort.signal,
          }),
        }))(),
        RELOAD_IMPORT_TIMEOUT_MS,
        "Extension reload import"
      );
      return {
        extensions: mergeCliExtensions(reloaded.extensions, cliExtensions),
        notices: reloaded.notices,
        rollbackModuleCache: () => transaction.rollback(),
      };
    } catch (error) {
      importAbort.abort();
      transaction.rollback();
      throw error;
    }
  };
}

const RELOAD_IMPORT_TIMEOUT_MS = 30_000;

/**
 * Inspect the thread the TUI would actually resume: the session index's
 * active pointer for this directory, unless PSS_THREAD_KEY forces a key.
 * A missing or unreadable index falls back to the legacy per-cwd key.
 */
async function resolveInspectionThreadKey(
  config: CodingAgentThreadConfig,
  cwd: string
): Promise<string> {
  if (config.keyFromEnv) {
    return config.key;
  }
  const index = await readSessionIndex(sessionIndexPath(config.directory));
  return activeSessionKey(index, cwd) ?? config.key;
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
  // The cwd covers loose `-e` extensions whose CommonJS helpers live
  // outside the entry directory (for example `plugins/review/index.mjs`
  // importing `../shared.cjs`); nested node_modules stay untouched.
  const roots = [
    cwd,
    ...(await Promise.all(
      targets.map(async (target) => dirname(await canonicalPath(target.path)))
    )),
  ];
  const addScope = async (scope: "global" | "project"): Promise<void> => {
    const paths = await extensionScopePaths({ cwd, home, scope });
    roots.push(paths.installRoot);
    // Managed extensions live at <installRoot>/node_modules/<package>; add
    // each package root so its own CommonJS helpers reload while nested
    // dependency trees stay cached.
    const settings = await readExtensionSettings(paths.settingsPath);
    for (const entry of settings.extensions) {
      if (entry.target.kind === "package") {
        roots.push(
          join(
            paths.installRoot,
            "node_modules",
            ...entry.target.packageName.split("/")
          )
        );
      }
    }
  };
  await addScope("global");
  try {
    await addScope("project");
  } catch {
    // Untrusted or malformed project layouts simply contribute no root.
  }
  // Node keys require.cache by real resolved filenames, so symlinked roots
  // must be canonicalized or their helpers would evade the transaction.
  return await Promise.all(roots.map(canonicalPath));
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExtensionFlag(value: string): boolean {
  return value === "-e" || value === "--extension";
}

function isTuiFlag(value: string): boolean {
  return isExtensionFlag(value) || value === "--name" || value === "--session";
}

function requiredTuiFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  missingMessage = `${flag} requires a value.`
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(missingMessage);
  }
  return value;
}

function uniqueTuiFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  current: string | undefined
): string {
  if (current !== undefined) {
    throw new Error(`${flag} may only be provided once.`);
  }
  return requiredTuiFlagValue(argv, index, flag);
}

function parseTuiArguments(argv: readonly string[]): {
  readonly extensionPaths: readonly string[];
  readonly sessionKey?: string;
  readonly sessionName?: string;
} {
  const paths: string[] = [];
  let sessionKey: string | undefined;
  let sessionName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--name") {
      sessionName = uniqueTuiFlagValue(argv, index, flag, sessionName);
      index += 1;
      continue;
    }
    if (flag === "--session") {
      sessionKey = uniqueTuiFlagValue(argv, index, flag, sessionKey);
      index += 1;
      continue;
    }
    if (!isExtensionFlag(flag)) {
      throw new Error(`Unknown pss option: ${flag}`);
    }
    const value = requiredTuiFlagValue(
      argv,
      index,
      flag,
      `${flag} requires a path value.`
    );
    paths.push(value);
    index += 1;
  }
  return {
    extensionPaths: paths,
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(sessionName === undefined ? {} : { sessionName }),
  };
}

function formatUsage(): string {
  return [
    "Usage: pss [command] [-e <path>] [--session <key>]",
    "",
    "Commands:",
    "  (no command)     Start the interactive TUI",
    "                   (-e/--extension <path> loads an extension for this run,",
    "                    --name <name> names the startup session,",
    "                    --session <key> resumes a specific session)",
    "  exec             Run one headless coding task",
    "  extension        Manage coding-agent extensions",
    "  inspect-thread   Print a report for the configured thread",
    "  rpc              Serve the versioned JSONL protocol on stdin/stdout",
    "  update           Update pss (--check, --channel <tag>)",
    "  help             Show this help message",
  ].join("\n");
}
