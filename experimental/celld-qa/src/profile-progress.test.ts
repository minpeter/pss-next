import { describe, expect, it } from "vitest";
import { createProgressReporter } from "./profile-progress";

describe("profile JSONL progress", () => {
  it("emits every 100 completions or 10 monotonic seconds", async () => {
    let now = 0;
    const lines: string[] = [];
    const reporter = createProgressReporter({
      clock: { now: () => now },
      sink: (line) => {
        lines.push(line);
      },
    });

    await reporter.record({
      admitted: 99,
      completed: 99,
      failed: 0,
      inFlight: 0,
    });
    now = 10_000;
    await reporter.record({
      admitted: 99,
      completed: 99,
      failed: 0,
      inFlight: 0,
    });
    await reporter.record({
      admitted: 199,
      completed: 199,
      failed: 0,
      inFlight: 0,
    });

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(lines.map((line) => JSON.parse(line).completed)).toEqual([99, 199]);
  });

  it("emits a final cleanup-observable record once", async () => {
    const lines: string[] = [];
    const reporter = createProgressReporter({
      clock: { now: () => 7 },
      sink: (line) => {
        lines.push(line);
      },
    });

    await reporter.finish({
      admitted: 3,
      completed: 3,
      failed: 0,
      inFlight: 0,
    });
    await reporter.finish({
      admitted: 3,
      completed: 3,
      failed: 0,
      inFlight: 0,
    });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      final: true,
      inFlight: 0,
    });
    expect(lines).toHaveLength(1);
  });

  it("awaits progress persistence before reporting completion", async () => {
    let persisted = false;
    const reporter = createProgressReporter({
      clock: { now: () => 0 },
      sink: async () => {
        await Promise.resolve();
        persisted = true;
      },
    });

    const pending = reporter.record({
      admitted: 100,
      completed: 100,
      failed: 0,
      inFlight: 0,
    });

    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(persisted).toBe(true);
  });
});
