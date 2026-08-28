import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { restartCelld, waitForListening } from "./celld-process-lifecycle";

describe("Celld process lifecycle", () => {
  it("removes every readiness listener after the ready event", async () => {
    // Given
    const child = spawn(
      process.execPath,
      [
        "-e",
        'process.stdin.resume(); process.stderr.write("noise"); process.stdout.write("celld listening on 127.0.0.1")',
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdoutListeners = child.stdout.listenerCount("data");
    const stderrListeners = child.stderr.listenerCount("data");
    const errorListeners = child.listenerCount("error");
    const exitListeners = child.listenerCount("exit");

    try {
      // When
      await waitForListening(child);

      // Then
      expect(child.stdout.listenerCount("data")).toBe(stdoutListeners);
      expect(child.stderr.listenerCount("data")).toBe(stderrListeners);
      expect(child.listenerCount("error")).toBe(errorListeners);
      expect(child.listenerCount("exit")).toBe(exitListeners);
      expect(child.stdout.readableFlowing).toBe(true);
      expect(child.stderr.readableFlowing).toBe(true);
    } finally {
      await terminate(child);
    }
  });

  it("preserves the readiness error when restart cleanup also fails", async () => {
    // Given
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const readinessError = new Error("readiness failed");
    const cleanupError = new Error("cleanup failed");
    const stop = vi.fn(() =>
      stop.mock.calls.length === 2
        ? Promise.reject(cleanupError)
        : Promise.resolve()
    );

    try {
      // When
      const restart = restartCelld("native", "run", 3000, "/tmp/watch", child, {
        start: () => child,
        stop,
        waitUntilReady: () => Promise.reject(readinessError),
      });

      // Then
      await expect(restart).rejects.toBe(readinessError);
      expect(readinessError.cause).toBe(cleanupError);
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      await terminate(child);
    }
  });
});

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
