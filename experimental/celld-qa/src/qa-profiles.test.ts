import { describe, expect, it } from "vitest";
import type { ProfileReport } from "./profile-runner";
import {
  campaignBaseUrl,
  campaignProgressPath,
  parseProfileArgs,
  profileViolations,
  runProfileCommand,
} from "./qa-profiles";

describe("profile CLI contract", () => {
  it("parses the exact profile surface", () => {
    expect(
      parseProfileArgs([
        "--",
        "--profile",
        "soak",
        "--base-url",
        "http://127.0.0.1:16423",
        "--progress",
        "run.jsonl",
        "--pid",
        "42",
      ])
    ).toEqual({
      baseUrl: "http://127.0.0.1:16423",
      pid: 42,
      profile: "soak",
      progressPath: "run.jsonl",
    });
    expect(() =>
      parseProfileArgs([
        "--profile",
        "unknown",
        "--base-url",
        "http://127.0.0.1:1",
      ])
    ).toThrow();
  });

  it("dispatches restart through churn and other profiles through the runner", async () => {
    const calls: string[] = [];
    const dependencies = {
      runChurn: () => {
        calls.push("churn");
        return Promise.resolve({ ok: true });
      },
      runLane: () => {
        calls.push("lane");
        return Promise.resolve({ ok: true });
      },
    };

    await runProfileCommand(
      { baseUrl: "http://127.0.0.1:1", profile: "restart" },
      dependencies
    );
    await runProfileCommand(
      { baseUrl: "http://127.0.0.1:1", profile: "wide" },
      dependencies
    );

    expect(calls).toEqual(["churn", "lane"]);
  });

  it("routes one progress stream directly and disambiguates multiple profiles", () => {
    const args = ["--progress", "/var/tmp/celld-progress"];

    expect(campaignProgressPath(args, "soak", 1)).toBe(
      "/var/tmp/celld-progress"
    );
    expect(campaignProgressPath(args, "wide", 2)).toBe(
      "/var/tmp/celld-progress.wide.jsonl"
    );
    expect(campaignProgressPath([], "soak", 1)).toBeUndefined();
  });

  it("keeps campaign traffic on the selected loopback Celld port", () => {
    expect(campaignBaseUrl([], 16_431)).toBe("http://127.0.0.1:16431");
    expect(() =>
      campaignBaseUrl(["--base-url", "https://example.com"], 16_431)
    ).toThrow("--base-url must be loopback");
  });

  it("rejects completed restart churn reports containing failed requests", () => {
    const report: ProfileReport = {
      admitted: 5000,
      cleanup: { aborted: 0, drained: true, inFlight: 0 },
      completed: 5000,
      correct: 2416,
      elapsedMs: 1,
      failed: 2584,
      incorrect: 0,
      latency: null,
      latencySamples: [],
      processMetrics: null,
      runnerMetrics: {
        cpuSystemMicros: 0,
        cpuUserMicros: 0,
        throughputPerSecond: 5_000_000,
      },
    };

    expect(profileViolations(report, true)).toEqual([
      "2584 requests failed",
      "2416 of 5000 completed requests were correct",
    ]);
    expect(profileViolations(report, false)).toContain(
      "profile cleanup left owned resources"
    );
  });
});
