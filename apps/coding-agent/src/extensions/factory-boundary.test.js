import { describe, expect, it } from "vitest";
import { threadMigration } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";

describe("default-export extension runtime boundary", () => {
  it("qualifies migration capabilities with the extension id", async () => {
    // Given
    const extensionModule = {
      default(pss) {
        pss.provide(
          threadMigration({
            id: "sanitize",
            migrate(snapshot) {
              return snapshot;
            },
            version: 2,
          })
        );
      },
      id: "workspace-policy",
    };

    // When
    const host = await createCodingAgentExtensionHost([extensionModule]);

    // Then
    expect(host.threadMigrations).toEqual([
      expect.objectContaining({
        id: "workspace-policy/sanitize",
        version: 2,
      }),
    ]);
    await host.dispose();
  });

  it("attributes invalid storage migrations to extension configuration", async () => {
    // Given
    const extensionModule = {
      default(pss) {
        pss.provide(
          threadMigration({
            id: "invalid",
            migrate: "not-a-function",
            version: 0,
          })
        );
      },
      id: "workspace-policy",
    };

    // When
    const loading = createCodingAgentExtensionHost([extensionModule]);

    // Then
    await expect(loading).rejects.toMatchObject({
      cause: expect.objectContaining({
        message:
          'Thread migration "workspace-policy/invalid" version must be a positive integer',
      }),
      extensionId: "workspace-policy",
      phase: "configure",
    });
  });

  it("rejects invalid qualified migration ids during configuration", async () => {
    // Given
    const extensionModule = {
      default(pss) {
        pss.provide(
          threadMigration({
            id: "bad id",
            migrate(snapshot) {
              return snapshot;
            },
            version: 1,
          })
        );
      },
      id: "workspace-policy",
    };

    // When
    const loading = createCodingAgentExtensionHost([extensionModule]);

    // Then
    await expect(loading).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "Invalid thread migration id: workspace-policy/bad id",
      }),
      extensionId: "workspace-policy",
      phase: "configure",
    });
  });

  it("rejects an invalid default export with its stable id", async () => {
    // Given
    const extensionModule = {
      default: "not a factory",
      id: "broken-extension",
    };

    // When
    const loading = createCodingAgentExtensionHost([extensionModule]);

    // Then
    await expect(loading).rejects.toThrow(
      'Coding agent extension "broken-extension" default export must be a function'
    );
  });
});
