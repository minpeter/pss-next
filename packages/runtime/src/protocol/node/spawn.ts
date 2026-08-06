import { type SpawnOptions, spawn } from "node:child_process";
import { type ProtocolTransport, PssProtocolClient } from "../client";

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
  const transport: ProtocolTransport = {
    readable: child.stdout,
    write(data) {
      return new Promise<void>((resolve, reject) =>
        child.stdin?.write(data, (error) => (error ? reject(error) : resolve()))
      );
    },
    close() {
      child.stdin?.end();
      if (child.exitCode !== null) {
        return;
      }
      return new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    },
  };
  return new PssProtocolClient(transport);
}
