import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";
import { describe, expect, it } from "vitest";
import { createCodingAgent } from "./coding-agent";
import { createCodingAgentExtensionHost, threadMigration } from "./extensions";

describe("coding-agent persisted migrations", () => {
  it("passes extension migrations into the runtime thread loader", async () => {
    // Given
    const host = createInMemoryHost();
    await host.store.threads.commit(
      "qa",
      {
        state: {
          history: [{ content: "SECRET", role: "user" }],
          schemaVersion: 1,
        },
      },
      { expectedVersion: null }
    );
    let applications = 0;
    const extensionHost = await createCodingAgentExtensionHost([
      {
        id: "workspace-policy",
        default(pss) {
          pss.provide(
            threadMigration({
              id: "sanitize",
              migrate(snapshot) {
                applications += 1;
                return {
                  ...snapshot,
                  history: snapshot.history.map((message) => {
                    if (
                      message.role === "user" &&
                      typeof message.content === "string"
                    ) {
                      return {
                        ...message,
                        content:
                          message.content === "SECRET"
                            ? "[redacted]"
                            : message.content,
                      };
                    }
                    return message;
                  }),
                };
              },
              version: 1,
            })
          );
        },
      },
    ]);
    const provider = createOpenAICompatible({
      apiKey: "test",
      baseURL: "https://example.invalid/v1",
      name: "test",
    });
    const agent = await createCodingAgent({
      extensionHost,
      host,
      model: provider("model"),
      tools: {},
      workspace: "/tmp",
    });

    // When
    await agent.thread("qa").compact({
      endSeqExclusive: 1,
      startSeq: 0,
      summary: "sanitized",
    });

    // Then
    expect(applications).toBe(1);
    await expect(host.store.threads.load("qa")).resolves.toEqual(
      expect.objectContaining({
        state: expect.objectContaining({
          appliedMigrations: {
            "workspace-policy/sanitize": 1,
          },
          history: [{ content: "[redacted]", role: "user" }],
          schemaVersion: 3,
        }),
      })
    );
    await agent.dispose();
    await extensionHost.dispose();
  });
});
