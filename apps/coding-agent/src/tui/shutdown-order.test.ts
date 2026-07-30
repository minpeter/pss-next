import { describe, expect, it } from "vitest";
import { shutdownSteps } from "./shutdown-order";

describe("shutdownSteps", () => {
  it("stops rendering before disposing rendered assistant views", () => {
    const steps = shutdownSteps();

    expect(steps.indexOf("stop-render")).toBeLessThan(
      steps.indexOf("dispose-assistant-views")
    );
  });

  it("erases the composer only after rendering stopped", () => {
    const steps = shutdownSteps();

    expect(steps.indexOf("stop-render")).toBeLessThan(
      steps.indexOf("erase-composer")
    );
  });
});
