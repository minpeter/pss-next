import { describe, expect, it } from "vitest";
import { applyProfileCelldEnvironment } from "./profile-celld-environment";

describe("profile Celld environment", () => {
  it("widens cold activations and restores an unset environment", () => {
    const environment: NodeJS.ProcessEnv = {};

    const restore = applyProfileCelldEnvironment(environment, "wide");

    expect(environment.CELLD_ACTIVATIONS).toBe("128");
    restore();
    expect(environment.CELLD_ACTIVATIONS).toBeUndefined();
  });

  it("preserves and restores an explicit operator value", () => {
    const environment: NodeJS.ProcessEnv = { CELLD_ACTIVATIONS: "64" };

    const restore = applyProfileCelldEnvironment(environment, "wide");

    expect(environment.CELLD_ACTIVATIONS).toBe("64");
    restore();
    expect(environment.CELLD_ACTIVATIONS).toBe("64");
  });

  it("keeps the Celld default for non-wide profiles", () => {
    const environment: NodeJS.ProcessEnv = {};

    const restore = applyProfileCelldEnvironment(environment, "restart");

    expect(environment.CELLD_ACTIVATIONS).toBeUndefined();
    restore();
    expect(environment.CELLD_ACTIVATIONS).toBeUndefined();
  });
});
