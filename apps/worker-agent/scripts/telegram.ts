import { resolve } from "node:path";

import { isMainModule } from "../src/shared/is-main-module";
import { logError } from "../src/worker-log";
import { forwardUpdates as forwardUpdatesImpl } from "./telegram-forward";
import {
  isAbortError as isAbortErrorImpl,
  normalizeError,
  peakOffset as peakOffsetImpl,
  sleepMs as sleepMsImpl,
  warmLocalWorker as warmLocalWorkerImpl,
} from "./telegram-helpers";
import { relay as relayImpl, webhook as webhookImpl } from "./telegram-relay";

export const forwardUpdates = forwardUpdatesImpl;
export const isAbortError = isAbortErrorImpl;
export const peakOffset = peakOffsetImpl;
export const relay = relayImpl;
export const sleepMs = sleepMsImpl;
export const warmLocalWorker = warmLocalWorkerImpl;
export const webhook = webhookImpl;

export async function main(command = process.argv[2]): Promise<void> {
  loadDevVars();
  if (command === "relay") {
    await relay();
    return;
  }
  if (command === "webhook") {
    await webhook();
    return;
  }
  throw new Error("usage: telegram.ts relay|webhook");
}

function loadDevVars(): void {
  process.loadEnvFile(resolve(import.meta.dirname, "../.dev.vars"));
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    logError(normalizeError(error), {
      action: "relay_fatal",
      scope: "telegram-relay",
    });
    process.exitCode = 1;
  }
}
