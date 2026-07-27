import { spawn } from "node:child_process";
import { CODING_AGENT_PACKAGE_NAME, type UpdateChannel } from "./check";
import {
  findPackageManagerSpec,
  type InstallMethod,
  PACKAGE_MANAGERS,
} from "./install-method";

export interface InstallInvocation {
  readonly args: readonly string[];
  readonly command: string;
}

export function installInvocation({
  manager,
  version,
  platform,
}: {
  manager: string;
  version: string;
  platform: NodeJS.Platform;
}): InstallInvocation {
  const spec = `${CODING_AGENT_PACKAGE_NAME}@${version}`;
  const pm = findPackageManagerSpec(manager);
  if (pm === undefined) {
    throw new RangeError(`unknown package manager: ${manager}`);
  }
  const baseArgs = pm.installArgs(spec);
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", manager, ...baseArgs],
    };
  }
  return { command: manager, args: baseArgs };
}

export function formatInvocation(invocation: InstallInvocation): string {
  return [invocation.command, ...invocation.args].join(" ");
}

export function describeInstallMethod(method: InstallMethod): string {
  switch (method.kind) {
    case "global":
      return `${method.manager} (global install)`;
    case "ephemeral":
      return `${method.runner} (one-off cache)`;
    case "unknown":
      return "unknown";
    default:
      return assertNever(method);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected install method: ${JSON.stringify(value)}`);
}

export function manualInstallCommands(channel: UpdateChannel): string {
  const spec = `${CODING_AGENT_PACKAGE_NAME}@${channel}`;
  return [
    ...PACKAGE_MANAGERS.map(
      (pm) => `  ${pm.name} ${pm.installArgs(spec).join(" ")}`
    ),
    "",
  ].join("\n");
}

export const defaultSpawnInstall = (
  command: string,
  args: readonly string[]
): Promise<number> =>
  new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: "inherit",
    });
    child.on("error", () => resolvePromise(1));
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
