import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { taskValidatorProcessError } from "./task-utility-validator-protocol";

export const TASK_VALIDATOR_NETWORK_ISOLATED_ENV =
  "PSS_TASK_VALIDATOR_NETWORK_ISOLATED";
export const TASK_VALIDATOR_SANDBOX_ENV = "PSS_TASK_VALIDATOR_SANDBOX";
const DEFAULT_TASK_VALIDATOR_SANDBOX = "/usr/bin/bwrap";

export async function taskValidatorSandboxCommand({
  fixtureId,
  targetFile,
  validatorEntrypoint,
  workspace,
}: {
  readonly fixtureId: string;
  readonly targetFile: string;
  readonly validatorEntrypoint: string;
  readonly workspace: string;
}): Promise<{ readonly args: readonly string[]; readonly executable: string }> {
  const executable =
    process.env[TASK_VALIDATOR_SANDBOX_ENV] ?? DEFAULT_TASK_VALIDATOR_SANDBOX;
  if (!isAbsolute(executable)) {
    throw taskValidatorProcessError(
      "process",
      "Task validator sandbox path must be absolute."
    );
  }
  try {
    await access(executable, constants.X_OK);
  } catch {
    throw taskValidatorProcessError(
      "process",
      "Task validator requires an executable bubblewrap sandbox."
    );
  }
  const mounts = ["/usr", "/lib", "/lib64"].flatMap((path) =>
    existsSync(path) ? ["--ro-bind", path, path] : []
  );
  const nodeDirectory = dirname(process.execPath);
  const validatorDirectory = dirname(validatorEntrypoint);
  return {
    args: [
      ...(process.env[TASK_VALIDATOR_NETWORK_ISOLATED_ENV] === "1"
        ? []
        : ["--unshare-net"]),
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--die-with-parent",
      ...mounts,
      "--ro-bind",
      nodeDirectory,
      nodeDirectory,
      "--ro-bind",
      validatorDirectory,
      validatorDirectory,
      "--ro-bind",
      workspace,
      workspace,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--chdir",
      workspace,
      process.execPath,
      "--conditions=@minpeter/pss-source",
      "--permission",
      `--allow-fs-read=${workspace}`,
      validatorEntrypoint,
      fixtureId,
      workspace,
      targetFile,
    ],
    executable,
  };
}
