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

  it("bounds concurrent object deletion for large prefixes", async () => {
    const keys = Array.from({ length: 40 }, (_, index) => `run/key-${index}`);
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method !== "DELETE") {
        return new Response(
          `<ListBucketResult>${keys.map((key) => `<Key>${key}</Key>`).join("")}</ListBucketResult>`
        );
      }
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await Promise.resolve();
      activeDeletes -= 1;
      return new Response(null, { status: 204 });
    });

    await cleanupPrefix("run", {
      endpoint: "http://127.0.0.1:14566",
      fetchImpl,
    });

    expect(maxActiveDeletes).toBeLessThanOrEqual(16);
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")
    ).toHaveLength(keys.length);
  });
});
