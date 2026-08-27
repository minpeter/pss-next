import { describe, expect, it, vi } from "vitest";
import { cleanupPrefix } from "./celld-bucket";

describe("Celld bucket cleanup boundary", () => {
  it("rejects a remote endpoint before issuing requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      cleanupPrefix("unsafe", {
        endpoint: "https://s3.example.com",
        fetchImpl,
      })
    ).rejects.toThrow("Celld QA endpoint must be loopback");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
