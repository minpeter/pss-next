import { describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: openMock };
});

import { readUpdateCheckCache } from "./check";

describe("update cache file handle", () => {
  it("validates and reads through one bounded file handle", async () => {
    const cache = {
      checkedAt: "2026-07-21T00:00:00.000Z",
      tags: { latest: "0.0.14" },
    };
    const payload = Buffer.from(JSON.stringify(cache));
    const close = vi.fn(() => Promise.resolve());
    const read = vi.fn(
      (buffer: Buffer, offset: number, length: number, position: number) => {
        const chunk = payload.subarray(position, position + length);
        chunk.copy(buffer, offset);
        return Promise.resolve({ buffer, bytesRead: chunk.length });
      }
    );
    openMock.mockResolvedValue({
      close,
      read,
      stat: () => Promise.resolve({ isFile: () => true, size: payload.length }),
    });

    await expect(
      readUpdateCheckCache("/cache/update-check.json")
    ).resolves.toEqual(cache);
    expect(openMock).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
