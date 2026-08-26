import { describe, expect, it } from "vitest";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

describe("coding-agent extension id boundary", () => {
  it.each(["extension", "@scope/extension", "name.with_parts:1-2"])(
    "accepts the terminal-safe id %s",
    async (id) => {
      // Given
      const extension: CodingAgentExtensionModule = {
        default: () => undefined,
        id,
      };

      // When
      const host = await createCodingAgentExtensionHost([extension]);

      // Then
      await host.dispose();
    }
  );

  it("snapshots an extension id exactly once", async () => {
    // Given
    let reads = 0;
    const extension: CodingAgentExtensionModule = {
      default: () => undefined,
      get id() {
        reads += 1;
        return reads === 1 ? "stable-extension" : "__proto__";
      },
    };

    // When
    const host = await createCodingAgentExtensionHost([extension]);

    // Then
    expect(reads).toBe(1);
    await host.dispose();
  });

  it("does not reread secret control bytes from an extension id getter", async () => {
    // Given
    let reads = 0;
    const extension: CodingAgentExtensionModule = {
      default: () => undefined,
      get id() {
        reads += 1;
        return reads === 1
          ? "stable-extension"
          : "secret-token\u001b[2J\nSECOND_LINE";
      },
    };

    // When
    const host = await createCodingAgentExtensionHost([extension]);

    // Then
    expect(reads).toBe(1);
    await host.dispose();
  });

  it("rejects duplicate snapshots without reflecting their id", async () => {
    // Given
    const privateId = "private-api-token";
    const reads = [{ count: 0 }, { count: 0 }];
    const extensions = reads.map(
      (read): CodingAgentExtensionModule => ({
        default: () => undefined,
        get id() {
          read.count += 1;
          return privateId;
        },
      })
    );

    // When
    const failure = createCodingAgentExtensionHost(extensions);

    // Then
    await expect(failure).rejects.toThrow(
      "Duplicate coding agent extension id."
    );
    await expect(failure).rejects.not.toThrow(privateId);
    expect(reads.map(({ count }) => count)).toEqual([1, 1]);
  });

  it("rejects extension ids beyond the boundary length limit", async () => {
    // Given
    const extension: CodingAgentExtensionModule = {
      default: () => undefined,
      id: "a".repeat(215),
    };

    // When
    const failure = createCodingAgentExtensionHost([extension]);

    // Then
    await expect(failure).rejects.toThrow("Invalid extension id.");
  });
});
