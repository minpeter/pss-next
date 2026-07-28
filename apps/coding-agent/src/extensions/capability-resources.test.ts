import { describe, expect, it } from "vitest";
import { resources, sessionGuard } from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionApi } from "./types";

const ABSOLUTE_PATHS = /must be absolute paths/;
const AT_LEAST_ONE_DIRECTORY = /at least one directory/;
const GUARD_HANDLERS = /beforeFork or beforeSwitch/;
const MUST_BE_FUNCTION = /must be a function/;

function extensionWith(
  configure: (pss: CodingAgentExtensionApi) => void,
  id = "sample"
) {
  return { default: configure, id };
}

async function configureFailureCause(
  configure: (pss: CodingAgentExtensionApi) => void
): Promise<string> {
  try {
    const host = await createCodingAgentExtensionHost([
      extensionWith(configure),
    ]);
    await host.dispose();
  } catch (error) {
    const cause = (error as Error).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error("expected configure to fail");
}

describe("resources capability", () => {
  it("exposes contributed prompt and skill roots on the host", async () => {
    const host = await createCodingAgentExtensionHost([
      extensionWith((pss) => {
        pss.provide(
          resources({ prompts: ["/abs/prompts"], skills: ["/abs/skills"] })
        );
      }),
    ]);
    try {
      expect(host.resourceRoots).toEqual({
        prompts: ["/abs/prompts"],
        skills: ["/abs/skills"],
      });
    } finally {
      await host.dispose();
    }
  });

  it("rejects relative resource paths", async () => {
    expect(
      await configureFailureCause((pss) => {
        pss.provide(resources({ prompts: ["relative/prompts"] }));
      })
    ).toMatch(ABSOLUTE_PATHS);
  });

  it("rejects empty resource capabilities", async () => {
    expect(
      await configureFailureCause((pss) => {
        pss.provide(resources({}));
      })
    ).toMatch(AT_LEAST_ONE_DIRECTORY);
  });
});

describe("session-guard capability", () => {
  it("exposes registered guards with their owning extension", async () => {
    const guard = { beforeSwitch: () => undefined };
    const host = await createCodingAgentExtensionHost([
      extensionWith((pss) => {
        pss.provide(sessionGuard(guard));
      }, "guarding"),
    ]);
    try {
      expect(host.sessionGuards).toHaveLength(1);
      expect(host.sessionGuards[0]?.extensionId).toBe("guarding");
      expect(typeof host.sessionGuards[0]?.guard.beforeSwitch).toBe("function");
    } finally {
      await host.dispose();
    }
  });

  it("rejects guards without any handler", async () => {
    expect(
      await configureFailureCause((pss) => {
        pss.provide(sessionGuard({}));
      })
    ).toMatch(GUARD_HANDLERS);
  });

  it("rejects non-function guard handlers", async () => {
    expect(
      await configureFailureCause((pss) => {
        pss.provide(
          sessionGuard({
            beforeSwitch: true as unknown as () => undefined,
          })
        );
      })
    ).toMatch(MUST_BE_FUNCTION);
  });
});
