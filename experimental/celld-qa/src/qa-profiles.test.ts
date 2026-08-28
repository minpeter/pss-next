import { describe, expect, it } from "vitest";
import {
  campaignProgressPath,
  parseProfileArgs,
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
});
