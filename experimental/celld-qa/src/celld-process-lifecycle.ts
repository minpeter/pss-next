import { spawn } from "node:child_process";
import {
  celldArguments,
  celldProcessConfiguration,
  LIFECYCLE_TIMEOUT_MS,
  localEnvironment,
} from "./celld-process-config";

export type CelldSurface = "native" | "container";
export type CelldChild = ReturnType<typeof spawn>;

interface RestartDependencies {
  readonly start?: typeof startCelld;
  readonly stop?: typeof stopCelld;
  readonly waitUntilReady?: typeof waitForListening;
}

export function startCelld(
  surface: CelldSurface,
  prefix: string,
  port: number,
  watch: string
): CelldChild {
  const configuration = celldProcessConfiguration();
  const args = celldArguments({ ...configuration, port, prefix });
  if (surface === "native") {
    return spawn(configuration.celld, args, {
      env: {
        ...localEnvironment(),
        CELLD_WATCH: watch,
        TMPDIR: "/var/tmp",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const environment = localEnvironment();
  const sessionToken = environment.AWS_SESSION_TOKEN;
  return spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--name",
      `pss-celld-${surface}-${port}`,
      "-e",
      `AWS_ACCESS_KEY_ID=${environment.AWS_ACCESS_KEY_ID}`,
      "-e",
      `AWS_SECRET_ACCESS_KEY=${environment.AWS_SECRET_ACCESS_KEY}`,
      ...(sessionToken === undefined
        ? []
        : ["-e", `AWS_SESSION_TOKEN=${sessionToken}`]),
      "-e",
      `S3_ENDPOINT=${configuration.endpoint}`,
      "-e",
      `CELLD_WATCH=${watch}`,
      "-e",
      "TMPDIR=/var/tmp",
      "ghcr.io/denoland/celld:v0.3.0",
      ...args,
    ],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

export function waitForListening(child: CelldChild): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Celld readiness timed out"));
    }, LIFECYCLE_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onStderrData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("celld listening on")) {
        cleanup();
        child.stdout?.resume();
        child.stderr?.resume();
        resolveReady();
      }
    };
    const onStderrData = (): void => undefined;
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Celld exited before readiness: ${code}`));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onStderrData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function stopCelld(child: CelldChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForExit(child))) {
    throw new Error("Celld shutdown timed out after SIGKILL");
  }
}

export async function restartCelld(
  surface: CelldSurface,
  prefix: string,
  port: number,
  watch: string,
  child: CelldChild,
  dependencies: RestartDependencies = {}
): Promise<CelldChild> {
  const stop = dependencies.stop ?? stopCelld;
  const start = dependencies.start ?? startCelld;
  const waitUntilReady = dependencies.waitUntilReady ?? waitForListening;
  await stop(child);
  const restarted = start(surface, prefix, port, watch);
  try {
    await waitUntilReady(restarted);
    return restarted;
  } catch (error) {
    try {
      await stop(restarted);
    } catch (cleanupError) {
      if (error instanceof Error && error.cause === undefined) {
        error.cause = cleanupError;
      }
    }
    throw error;
  }
}

function waitForExit(child: CelldChild): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, LIFECYCLE_TIMEOUT_MS);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}
