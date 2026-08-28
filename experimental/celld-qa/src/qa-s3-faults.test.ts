import { describe, expect, it, vi } from "vitest";
import { parseS3FaultCli, runS3FaultCli } from "./qa-s3-faults";

describe("qa:s3:faults CLI boundary", () => {
  it("parses explicit loopback endpoints and emits the aggregate report", async () => {
    // Given
    const write = vi.fn();
    const run = vi.fn().mockResolvedValue({ ok: true, scenarios: [] });

    // When
    const exitCode = await runS3FaultCli(
      [
        "--proxy-url",
        "http://127.0.0.1:14567",
        "--control-url",
        "http://127.0.0.1:14568",
        "--toxiproxy-url",
        "http://127.0.0.1:18474",
      ],
      { run, write }
    );

    // Then
    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith({
      controlUrl: "http://127.0.0.1:14568",
      proxyUrl: "http://127.0.0.1:14567",
      toxiproxyUrl: "http://127.0.0.1:18474",
    });
    expect(write).toHaveBeenCalledWith('{"ok":true,"scenarios":[]}\n');
  });

  it("rejects remote endpoints at the CLI boundary", () => {
    // Given / When / Then
    expect(() =>
      parseS3FaultCli(["--proxy-url", "http://10.0.0.2:14567"])
    ).toThrow("loopback");
  });

  it("returns failure when any binary observable is false", async () => {
    // Given
    const run = vi.fn().mockResolvedValue({
      ok: false,
      scenarios: [
        { detail: "reset not observed", kind: "reset", observed: false },
      ],
    });

    // When
    const exitCode = await runS3FaultCli([], { run, write: vi.fn() });

    // Then
    expect(exitCode).toBe(1);
  });
});
