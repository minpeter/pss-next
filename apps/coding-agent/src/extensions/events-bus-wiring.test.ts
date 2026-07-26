import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule, ExtensionJsonValue } from "./types";

async function createTestAgent() {
  const provider = createOpenAICompatible({
    apiKey: "test",
    baseURL: "https://example.com/v1",
    name: "test",
  });
  return await createAgent({ model: provider("model") });
}

async function settle(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe("extension services event bus wiring", () => {
  it("routes extension-emitted events between extensions", async () => {
    // Given
    const received: (ExtensionJsonValue | undefined)[] = [];
    const listener: CodingAgentExtensionModule = {
      default(pss) {
        pss.on("activate", ({ services }) => {
          const unsubscribe = services.events.on(
            "checkpoint:saved",
            (payload) => {
              received.push(payload);
            }
          );
          return () => {
            unsubscribe();
          };
        });
      },
      id: "listener",
    };
    const emitter: CodingAgentExtensionModule = {
      default(pss) {
        pss.on("activate", ({ services }) => {
          services.events.emit("checkpoint:saved", { revision: 7 });
          return;
        });
      },
      id: "emitter",
    };

    // When
    const host = await createCodingAgentExtensionHost([listener, emitter]);
    const agent = await createTestAgent();
    try {
      await host.activate(agent, "exec");
      await settle();
    } finally {
      await host.dispose();
      await agent.dispose();
    }

    // Then
    expect(received).toEqual([{ revision: 7 }]);
  });

  it("delivers host provider observations while blocking extension spoofing", async () => {
    // Given
    const received: (ExtensionJsonValue | undefined)[] = [];
    let spoofError: unknown;
    const observer: CodingAgentExtensionModule = {
      default(pss) {
        pss.on("activate", ({ services }) => {
          services.events.on("provider:response", (payload) => {
            received.push(payload);
          });
          try {
            services.events.emit("provider:response", { status: 500 });
          } catch (error) {
            spoofError = error;
          }
          return;
        });
      },
      id: "observer",
    };

    // When
    const host = await createCodingAgentExtensionHost([observer]);
    const agent = await createTestAgent();
    try {
      await host.activate(agent, "exec");
      host.emitHostEvent("provider:response", { status: 200 });
      await settle();
    } finally {
      await host.dispose();
      await agent.dispose();
    }
    host.emitHostEvent("provider:response", { status: 201 });
    await settle();

    // Then
    expect(received).toEqual([{ status: 200 }]);
    expect(spoofError).toBeInstanceOf(TypeError);
  });
});
