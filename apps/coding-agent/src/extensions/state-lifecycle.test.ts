import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

const readOnlyPattern = /read-only after its runtime was disposed/u;
const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("extension state lifecycle across disposal", () => {
  it("allows cleanup to persist state and revokes writes afterwards", async () => {
    // Given
    const dataRoot = await mkdtemp(join(tmpdir(), "pss-state-lifecycle-"));
    cleanupRoots.push(dataRoot);
    let services: import("./types").CodingAgentExtensionServices | undefined;
    const extension: CodingAgentExtensionModule = {
      default(pss) {
        pss.on("activate", (context) => {
          services = context.services;
          return async () => {
            await context.services.state.set({ finalized: true });
          };
        });
      },
      id: "stateful",
    };
    const provider = createOpenAICompatible({
      apiKey: "test",
      baseURL: "https://example.com/v1",
      name: "test",
    });
    const agent = await createAgent({ model: provider("model") });
    const host = await createCodingAgentExtensionHost([extension], {
      dataRoot,
    });
    await host.activate(agent, "exec");

    // When — disposal runs the cleanup, which persists final state.
    await host.dispose();
    await agent.dispose();

    // Then
    await expect(services?.state.get()).resolves.toEqual({ finalized: true });
    await expect(services?.state.set({ late: true })).rejects.toThrow(
      readOnlyPattern
    );
  });
});
