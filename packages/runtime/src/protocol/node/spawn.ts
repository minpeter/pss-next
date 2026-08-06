import { type SpawnOptions, spawn } from "node:child_process";
import { type ProtocolTransport, PssProtocolClient } from "../client";

interface ChildOutcome {
  readonly error?: Error;
}

export interface SpawnPssClientOptions {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly spawn?: SpawnOptions;
}

export function spawnPssClient({
  args = ["rpc"],
  command = "pss",
  spawn: options = {},
}: SpawnPssClientOptions = {}): PssProtocolClient {
  const child = spawn(command, args, {
    ...options,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (!(child.stdin && child.stdout)) {
    throw new Error("PSS child process did not expose protocol pipes");
  }

  // Install error listeners synchronously: spawn failures (for example ENOENT)
  // are emitted on the next tick and must never become uncaught process errors.
  let settleReadiness: (outcome: ChildOutcome) => void = () => undefined;
  let settleCompletion: (outcome: ChildOutcome) => void = () => undefined;
  const readiness = new Promise<ChildOutcome>((resolve) => {
    settleReadiness = resolve;
  });
  const completion = new Promise<ChildOutcome>((resolve) => {
    settleCompletion = resolve;
  });
  child.once("spawn", () => settleReadiness({}));
  child.once("error", (error) => {
    child.stdout?.destroy(error);
    settleReadiness({ error });
    settleCompletion({ error });
  });
  child.once("exit", () => settleCompletion({}));
  child.stdin.on("error", (error) => {
    child.stdout?.destroy(error);
  });

  const transport: ProtocolTransport = {
    readable: child.stdout,
    async write(data) {
      const outcome = await readiness;
      if (outcome.error) {
        throw outcome.error;
      }
      await new Promise<void>((resolve, reject) =>
        child.stdin?.write(data, (error) => (error ? reject(error) : resolve()))
      );
    },
    async close() {
      child.stdin?.end();
      const outcome = await completion;
      if (outcome.error) {
        throw outcome.error;
      }
    },
  };
  return new PssProtocolClient(transport);
}
