import { runUpdateCommand } from "./command";
import type { InstallMethod } from "./install-method";

interface Harness {
  readonly output: () => string;
  readonly run: () => Promise<number>;
  readonly spawns: readonly { command: string; args: readonly string[] }[];
}

const DEFAULT_METHOD: InstallMethod = { kind: "global", manager: "pnpm" };
const DEFAULT_PLATFORM: NodeJS.Platform = "linux";

export function createHarness(
  options: {
    args?: readonly string[];
    version?: string | undefined;
    method?: InstallMethod;
    tags?: Readonly<Record<string, string>>;
    spawnExitCode?: number;
    platform?: NodeJS.Platform;
  } = {}
): Harness {
  const {
    args = [],
    method = DEFAULT_METHOD,
    tags = { latest: "0.0.14" },
    spawnExitCode = 0,
    platform = DEFAULT_PLATFORM,
  } = options;
  const version = "version" in options ? options.version : "0.0.13";
  let output = "";
  const spawns: { command: string; args: readonly string[] }[] = [];

  return {
    output: () => output,
    spawns,
    run: () =>
      runUpdateCommand({
        args,
        stdout: {
          write(text: string): void {
            output += text;
          },
        },
        env: {},
        version,
        binPath: "/irrelevant/bin/pss.js",
        platform,
        fetchTags: () => Promise.resolve(tags),
        detectInstall: () => Promise.resolve(method),
        spawnInstall: (command, args) => {
          spawns.push({ command, args });
          return Promise.resolve(spawnExitCode);
        },
      }),
  };
}
