import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CelldUnexpectedExitError,
  observeCelldExit,
} from "./celld-process-output";

describe("Celld process output observer", () => {
  it("fails immediately with bounded process output and exit status", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.stderr.write('celld panic detail'); process.exit(7)",
    ]);
    const observer = observeCelldExit(child);

    const error = await observer.exit.catch((reason: unknown) => reason);
    observer.dispose();

    expect(error).toBeInstanceOf(CelldUnexpectedExitError);
    expect(error).toMatchObject({
      exitCode: 7,
      signal: null,
      stderr: "celld panic detail",
    });
  });
});
