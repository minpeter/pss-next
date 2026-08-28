import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const COMPOSE_FILE = resolve(PACKAGE_ROOT, "compose.yaml");

export async function stopLocalStack(): Promise<void> {
  await execFile(
    "docker",
    ["compose", "--file", COMPOSE_FILE, "stop", "localstack"],
    { cwd: PACKAGE_ROOT }
  );
}

export async function startLocalStack(): Promise<void> {
  await execFile(
    "docker",
    [
      "compose",
      "--file",
      COMPOSE_FILE,
      "up",
      "--detach",
      "--wait",
      "localstack",
    ],
    { cwd: PACKAGE_ROOT }
  );
}
