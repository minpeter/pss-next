import { describe, expect, it } from "vitest";
import { settleS3Cleanup } from "./s3-fault-cleanup";

describe("S3 fault cleanup settlement", () => {
  it("attempts every operation and measurement after failures", async () => {
    const calls: string[] = [];

    const cleanup = settleS3Cleanup(
      [
        () => {
          calls.push("stop");
          return Promise.reject(new Error("stop failed"));
        },
        () => {
          calls.push("reset");
          return Promise.resolve();
        },
        () => {
          calls.push("delete");
          return Promise.reject(new Error("delete failed"));
        },
      ],
      () => {
        calls.push("measure");
        return Promise.resolve({
          containers: 0,
          ports: 0,
          prefixObjects: 0,
          processes: 0,
          proxyFaults: 0,
          watchPaths: 0,
        });
      }
    );

    await expect(cleanup).rejects.toThrow("S3 cleanup failed");
    expect(calls).toEqual(["stop", "reset", "delete", "measure"]);
  });
});
