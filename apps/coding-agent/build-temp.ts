import { join } from "node:path";

interface ConfigureBuildTempOptions {
  readonly ensureDirectory: (path: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
}

export const configureBuildTemp = ({
  ensureDirectory,
  env,
  home,
}: ConfigureBuildTempOptions): string => {
  const configured = env.TMPDIR ?? env.TMP ?? env.TEMP;
  const directory =
    configured ??
    join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "pss", "build-tmp");

  if (configured === undefined) {
    ensureDirectory(directory);
  }
  env.TMPDIR ??= directory;
  env.TMP ??= directory;
  env.TEMP ??= directory;
  return directory;
};
