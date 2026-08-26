import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TaskUtilityFixture } from "./task-utility-fixtures";
import { taskValidatorSandboxCommand } from "./task-utility-sandbox";
import { taskValidatorCheckIds } from "./task-utility-validator-checks";
import {
  completeTaskValidation,
  type TaskValidatorErrorKind,
  taskValidatorProcessError,
} from "./task-utility-validator-protocol";
import type { TaskValidation } from "./task-utility-validator-types";

export const TASK_VALIDATOR_MAX_OUTPUT_BYTES = 64 * 1024;
const TASK_VALIDATOR_TIMEOUT_MS = 1000;
const validatorEntrypoint = fileURLToPath(
  new URL("./task-utility-validator-child.mjs", import.meta.url)
);

export async function validateTaskWorkspace(
  fixture: TaskUtilityFixture,
  workspace: string
): Promise<TaskValidation> {
  const sandbox = await taskValidatorSandboxCommand({
    fixtureId: fixture.id,
    targetFile: fixture.targetFile,
    validatorEntrypoint,
    workspace,
  });
  const child = spawn(sandbox.executable, sandbox.args, {
    cwd: workspace,
    detached: true,
    env: sanitizedEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "pipe"] as const,
  });
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  const protocolStream = child.stdio[3];
  if (!(stdoutStream && stderrStream && protocolStream)) {
    await new Promise<void>((resolveClose) => {
      child.once("close", () => resolveClose());
      killProcessGroup(child);
    });
    throw taskValidatorProcessError(
      "process",
      "Validator output pipe is unavailable."
    );
  }

  const stdout = new BoundedOutput();
  const stderr = new BoundedOutput();
  const protocol = new BoundedOutput();
  let failure: TaskValidatorErrorKind | undefined;
  const terminate = (kind: TaskValidatorErrorKind): void => {
    if (failure !== undefined) {
      return;
    }
    failure = kind;
    killProcessGroup(child);
  };
  stdoutStream.on("data", (chunk: Buffer) => {
    stdout.append(chunk);
    if (stdout.exceeded) {
      terminate("output-limit");
    }
  });
  stderrStream.on("data", (chunk: Buffer) => {
    stderr.append(chunk);
    if (stderr.exceeded) {
      terminate("output-limit");
    }
  });
  protocolStream.on("data", (chunk: Buffer) => {
    protocol.append(chunk);
    if (protocol.exceeded) {
      terminate("output-limit");
    }
  });

  return await new Promise<TaskValidation>((resolve, reject) => {
    let spawnError: Error | undefined;
    const timeout = setTimeout(
      () => terminate("timeout"),
      TASK_VALIDATOR_TIMEOUT_MS
    );
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      Promise.resolve({
        code,
        details: { stderr: stderr.text, stdout: stdout.text },
        expectedCheckIds: taskValidatorCheckIds(fixture.id),
        failure,
        protocol: protocol.text,
        signal,
        spawnError,
      })
        .then(completeTaskValidation)
        .then(resolve, reject);
    });
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(isObject(error) && Reflect.get(error, "code") === "ESRCH")) {
      throw error;
    }
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  exceeded = false;

  append(chunk: Buffer): void {
    const remaining = TASK_VALIDATOR_MAX_OUTPUT_BYTES - this.bytes;
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining);
      this.chunks.push(captured);
      this.bytes += captured.byteLength;
    }
    if (chunk.byteLength > remaining) {
      this.exceeded = true;
    }
  }

  get text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["LANG", "LC_ALL", "TZ"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
}
