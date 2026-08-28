import type { ChildProcess } from "node:child_process";

const MAX_OUTPUT_BYTES = 8192;

export class CelldUnexpectedExitError extends Error {
  readonly exitCode: number | null;
  readonly name = "CelldUnexpectedExitError";
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string
  ) {
    super(
      `Celld exited unexpectedly: code=${exitCode ?? "null"} signal=${signal ?? "null"}`
    );
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

export interface CelldExitObserver {
  readonly dispose: () => void;
  readonly exit: Promise<never>;
}

export function observeCelldExit(child: ChildProcess): CelldExitObserver {
  let stdout = "";
  let stderr = "";
  let rejectExit: (reason: CelldUnexpectedExitError) => void = () => undefined;
  const exit = new Promise<never>((_resolve, reject) => {
    rejectExit = reject;
  });
  const onStdout = (chunk: Buffer | string): void => {
    stdout = appendTail(stdout, chunk);
  };
  const onStderr = (chunk: Buffer | string): void => {
    stderr = appendTail(stderr, chunk);
  };
  const onClose = (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    rejectExit(new CelldUnexpectedExitError(exitCode, signal, stdout, stderr));
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.once("close", onClose);
  return {
    dispose: () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("close", onClose);
    },
    exit,
  };
}

function appendTail(current: string, chunk: Buffer | string): string {
  const combined = `${current}${chunk.toString()}`;
  return combined.slice(-MAX_OUTPUT_BYTES);
}
