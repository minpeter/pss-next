import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type {
  CodingAgentExtensionExec,
  CodingAgentExtensionExecResult,
} from "./types";

const MAX_OUTPUT_LENGTH = 2_000_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const SECRET_ENV_SUFFIX = /_api_keys?$/iu;
const TERMINATION_GRACE_MS = 20;

export function createExtensionExec(options: {
  readonly signal: AbortSignal;
  readonly workspace: string;
}): CodingAgentExtensionExec {
  return Object.freeze({
    run: async (input: Parameters<CodingAgentExtensionExec["run"]>[0]) => {
      const cwd = await resolveWorkspacePath(options.workspace, input.cwd);
      if (typeof input.command !== "string" || input.command.length === 0) {
        throw new TypeError(
          "Extension exec command must be a non-empty string"
        );
      }
      if (
        !Array.isArray(input.args) ||
        input.args.some((arg: string) => typeof arg !== "string")
      ) {
        throw new TypeError("Extension exec args must be an array of strings");
      }
      const timeoutMs = input.timeoutMs ?? 120_000;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_TIMEOUT_MS
      ) {
        throw new TypeError(
          `Extension exec timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`
        );
      }
      return await runProcess({
        args: input.args,
        command: input.command,
        cwd,
        signal: input.signal,
        timeoutMs,
        hostSignal: options.signal,
      });
    },
  });
}

async function resolveWorkspacePath(
  workspace: string,
  requested: string | undefined
): Promise<string> {
  const root = await realpath(workspace);
  const candidate = await realpath(resolve(root, requested ?? "."));
  const path = relative(root, candidate);
  if (
    path === ".." ||
    path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("Extension exec cwd must stay inside the workspace");
  }
  return candidate;
}

async function runProcess(options: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly hostSignal: AbortSignal;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<CodingAgentExtensionExecResult> {
  if (options.hostSignal.aborted || options.signal?.aborted) {
    throw new Error("Extension exec was aborted before it started");
  }
  return await new Promise((resolveResult, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: true,
      env: filteredEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminated = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
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
      if (terminated) {
        return;
      }
      terminated = true;
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), TERMINATION_GRACE_MS);
    };
    const abort = () => terminate();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onData = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length <= MAX_OUTPUT_LENGTH
        ? next
        : next.slice(-MAX_OUTPUT_LENGTH);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = onData(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = onData(stderr, chunk);
    });
    options.hostSignal.addEventListener("abort", abort, { once: true });
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
      options.hostSignal.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      cleanup();
      resolveResult({
        cwd: options.cwd,
        exitCode,
        signal,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

function filteredEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !SECRET_ENV_SUFFIX.test(key)
      )
    ),
    CI: process.env.CI ?? "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}
