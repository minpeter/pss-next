import { describe, expect, it, vi } from "vitest";
import { measureCleanupRemaining } from "./campaign-cleanup-measure";

describe("campaign cleanup measurement", () => {
  it("derives every remaining count from owned resource probes", async () => {
    const remaining = await measureCleanupRemaining(
      {
        containerNames: ["gone", "live"],
        pids: [101, 102],
        ports: [16_431, 16_432],
        prefixObjectChecks: [
          () => Promise.resolve(0),
          () => Promise.resolve(3),
        ],
        proxyFaultChecks: [() => Promise.resolve(1), () => Promise.resolve(1)],
        watchPaths: ["/gone", "/live"],
      },
      {
        isContainerPresent: (name) => Promise.resolve(name === "live"),
        isPathPresent: (path) => Promise.resolve(path === "/live"),
        isPidAlive: (pid) => pid === 102,
        isPortOpen: (port) => Promise.resolve(port === 16_432),
      }
    );

    expect(remaining).toEqual({
      containers: 1,
      ports: 1,
      prefixObjects: 3,
      processes: 1,
      proxyFaults: 2,
      watchPaths: 1,
    });
  });

  it("derives zero counts from an empty owned resource scope", async () => {
    const remaining = await measureCleanupRemaining(
      {
        containerNames: [],
        pids: [],
        ports: [],
        prefixObjectChecks: [],
        proxyFaultChecks: [],
        watchPaths: [],
      },
      {
        isContainerPresent: vi.fn(),
        isPathPresent: vi.fn(),
        isPidAlive: vi.fn(),
        isPortOpen: vi.fn(),
      }
    );

    expect(remaining).toEqual({
      containers: 0,
      ports: 0,
      prefixObjects: 0,
      processes: 0,
      proxyFaults: 0,
      watchPaths: 0,
    });
  });
});
