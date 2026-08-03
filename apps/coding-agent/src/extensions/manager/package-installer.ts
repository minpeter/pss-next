import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandResult, RunExtensionCommand } from "./types";

export interface InstalledExtensionPackage {
  readonly packageName: string;
  readonly previousSpec?: string;
}

const DEFAULT_NPM_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT = 2_000_000;
const TERMINATION_GRACE_MS = 1000;

export const defaultRunExtensionCommand: RunExtensionCommand = (
  command,
  args
) =>
  new Promise((resolvePromise) => {
    const configuredTimeout = Number.parseInt(
      process.env.PSS_EXTENSION_NPM_TIMEOUT_MS ?? "",
      10
    );
    const timeoutMs =
      Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_NPM_TIMEOUT_MS;
    const child = spawn(command, [...args], {
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: string): string =>
      (current + chunk).slice(-MAX_COMMAND_OUTPUT);
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const terminate = () => {
      kill("SIGTERM");
      forceTimer = setTimeout(() => {
        kill("SIGKILL");
        settle({
          code: 1,
          stderr: stderr || `npm command timed out after ${timeoutMs}ms`,
          stdout,
        });
      }, TERMINATION_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const settle = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
      resolvePromise(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      settle({ code: 1, stderr: error.message, stdout });
    });
    child.on("close", (code) => {
      if (timedOut) {
        return;
      }
      settle({
        code: code ?? 1,
        stderr,
        stdout,
      });
    });
  });

export async function installExtensionPackage({
  installRoot,
  installSpec,
  packageName,
  runCommand = defaultRunExtensionCommand,
}: {
  readonly installRoot: string;
  readonly installSpec: string;
  readonly packageName?: string;
  readonly runCommand?: RunExtensionCommand;
}): Promise<InstalledExtensionPackage> {
  rejectUnsafeInstallSpec(installSpec);
  await ensurePackageRoot(installRoot);
  const before = await readDependencies(installRoot);
  const result = await runCommand("npm", [
    "install",
    "--prefix",
    installRoot,
    "--save-exact",
    "--ignore-scripts",
    "--install-links",
    "--no-audit",
    "--no-fund",
    "--",
    installSpec,
  ]);
  assertCommandSucceeded("install", result);
  const after = await readDependencies(installRoot);
  const resolvedName = packageName ?? changedDependency(before, after);
  if (!(resolvedName in after)) {
    throw new Error(
      `Installed extension package "${resolvedName}" is missing from dependencies`
    );
  }
  const previousSpec = before[resolvedName];
  return previousSpec === undefined
    ? { packageName: resolvedName }
    : { packageName: resolvedName, previousSpec };
}

export async function rollbackExtensionPackage({
  installRoot,
  installed,
  runCommand = defaultRunExtensionCommand,
}: {
  readonly installRoot: string;
  readonly installed: InstalledExtensionPackage;
  readonly runCommand?: RunExtensionCommand;
}): Promise<void> {
  if (installed.previousSpec === undefined) {
    await removeExtensionPackage({
      installRoot,
      packageName: installed.packageName,
      runCommand,
    });
    return;
  }
  await installExtensionPackage({
    installRoot,
    installSpec: rollbackInstallSpec(
      installed.packageName,
      installed.previousSpec,
      installRoot
    ),
    packageName: installed.packageName,
    runCommand,
  });
}

const ABSOLUTE_FILE_TARGET_PATTERN = /^[A-Za-z]:[\\/]/;

function rollbackInstallSpec(
  packageName: string,
  spec: string,
  installRoot: string
): string {
  if (spec.startsWith("file:")) {
    const target = spec.slice("file:".length);
    if (target.startsWith("/") || ABSOLUTE_FILE_TARGET_PATTERN.test(target)) {
      return spec;
    }
    return `file:${resolve(installRoot, target)}`;
  }
  if (
    spec.startsWith("git+") ||
    spec.startsWith("git@") ||
    spec.startsWith("github:") ||
    spec.startsWith("http:") ||
    spec.startsWith("https:") ||
    spec.startsWith("ssh:") ||
    spec.startsWith(".") ||
    spec.startsWith("/")
  ) {
    return spec;
  }
  return `${packageName}@${spec}`;
}

export async function removeExtensionPackage({
  installRoot,
  packageName,
  runCommand = defaultRunExtensionCommand,
}: {
  readonly installRoot: string;
  readonly packageName: string;
  readonly runCommand?: RunExtensionCommand;
}): Promise<void> {
  rejectUnsafeInstallSpec(packageName);
  const result = await runCommand("npm", [
    "uninstall",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--",
    packageName,
  ]);
  assertCommandSucceeded("remove", result);
}

async function ensurePackageRoot(installRoot: string): Promise<void> {
  await mkdir(installRoot, { mode: 0o700, recursive: true });
  try {
    await readFile(join(installRoot, "package.json"), "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
}

async function readDependencies(
  installRoot: string
): Promise<Readonly<Record<string, string>>> {
  const value: unknown = JSON.parse(
    await readFile(join(installRoot, "package.json"), "utf8")
  );
  if (
    value === null ||
    typeof value !== "object" ||
    !("dependencies" in value) ||
    value.dependencies === undefined
  ) {
    return {};
  }
  if (value.dependencies === null || typeof value.dependencies !== "object") {
    throw new TypeError("Managed extension dependencies must be an object");
  }
  const dependencies: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(value.dependencies)) {
    if (typeof specifier !== "string") {
      throw new TypeError("Managed extension dependency must be a string");
    }
    dependencies[name] = specifier;
  }
  return dependencies;
}

function changedDependency(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): string {
  const changed = Object.keys(after).filter(
    (name) => before[name] !== after[name]
  );
  if (changed.length !== 1) {
    throw new Error("Could not determine installed extension package name");
  }
  const name = changed[0];
  if (name === undefined) {
    throw new Error("Could not determine installed extension package name");
  }
  return name;
}

function assertCommandSucceeded(
  action: "install" | "remove",
  result: CommandResult
): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Extension package ${action} failed${detail ? `: ${detail}` : ""}`
    );
  }
}

function rejectUnsafeInstallSpec(spec: string): void {
  if (spec.startsWith("-")) {
    throw new Error("Extension install spec must not start with '-'");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}
