import { spawn } from "node:child_process";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { truncateToolOutput } from "./output";

const inputSchema = z
  .object({
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(600).optional(),
  })
  .strict();

interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 2_000_000 ? next : next.slice(-2_000_000);
}

const SIGKILL_GRACE_MS = 5000;

// Credentials must never leak into agent-spawned subprocesses. Every known
// provider key (current and future) ends in _API_KEY, so withhold that whole
// suffix family; tokens for CLIs the agent legitimately uses (gh, npm, cloud
// providers) stay, and untrusted workloads belong in a container.
const SECRET_ENV_SUFFIX = /_api_keys?$/iu;

function shellEnvironment(): NodeJS.ProcessEnv {
  const entries = Object.entries(process.env).filter(
    ([key]) => !SECRET_ENV_SUFFIX.test(key)
  );
  return {
    ...Object.fromEntries(entries),
    CI: process.env.CI ?? "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

function runCommand(
  workspace: string,
  command: string,
  timeoutMs: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: workspace,
      detached: true,
      env: shellEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    let killer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // Escalate so a command that ignores SIGTERM cannot hang the tool.
      killer = setTimeout(() => killGroup("SIGKILL"), SIGKILL_GRACE_MS);
      killer.unref();
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killer !== undefined) {
        clearTimeout(killer);
      }
      resolve({ exitCode, signal, stderr, stdout, timedOut });
    });
  });
}

export function createShellExecuteTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Execute a non-interactive shell command from the workspace directory. Not a sandbox: commands run with the user's permissions, but AI provider API keys are withheld from the child environment. Prefer read_file/glob_files/grep_files for inspection and edit_file/write_file for mutations. Run tests and builds after changes.",
    inputSchema,
    execute: async ({ command, timeout_seconds: timeoutSeconds = 120 }) => {
      const result = await runCommand(
        workspace,
        command,
        timeoutSeconds * 1000
      );
      return truncateToolOutput(
        [
          result.timedOut
            ? "ERROR - command timed out"
            : "OK - command finished",
          `exit_code: ${result.exitCode ?? "null"}`,
          `signal: ${result.signal ?? "none"}`,
          "stdout:",
          result.stdout,
          "stderr:",
          result.stderr,
        ].join("\n")
      );
    },
  });
}
