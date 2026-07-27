import { describe, expect, it, vi } from "vitest";
import { createCodingAgentExtensionHost } from "./host";
import { defineCodingAgentExtension } from "./types";

describe("extension command owner lookup", () => {
  it("wraps mixed-case command names so owner lookup finds the extension", async () => {
    const execute = vi.fn(async () => ({ success: true as const }));

    const host = await createCodingAgentExtensionHost([
      defineCodingAgentExtension({
        configure(registry) {
          registry.commands.register({
            description: "Review changes",
            execute,
            name: "Review",
          });
        },
        id: "reviewer",
      }),
    ]);

    try {
      const command = host.commands.find((item) => item.name === "Review");
      expect(command).toBeDefined();
      // Owner keys are lowercased; a successful wrap calls getCommandContext.
      // Without activation that throws — proving lookup matched "Review" → "review".
      await expect(command?.execute({ args: [] })).rejects.toThrow(
        'Coding agent extension "reviewer" is not active'
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
    }
  });
});
