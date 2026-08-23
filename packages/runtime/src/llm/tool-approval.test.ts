import { expect, it, vi } from "vitest";
import { createNoopTool } from "../testing/llm-test-utils";
import { snapshotToolsWithoutUnsupportedApproval } from "./tool-approval";

it("does not retain a tool-definition proxy after approval validation", () => {
  const get = vi.fn(Reflect.get);
  const definition = new Proxy(createNoopTool(), {
    get(target, property, receiver) {
      if (property === "needsApproval") {
        get(target, property, receiver);
        return true;
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === "needsApproval"
        ? false
        : Reflect.has(target, property);
    },
  });

  const snapshot = snapshotToolsWithoutUnsupportedApproval({
    danger: definition,
  });
  const snapshottedDefinition = snapshot?.danger as
    | Record<string, unknown>
    | undefined;

  expect(snapshottedDefinition).not.toBe(definition);
  expect(snapshottedDefinition?.needsApproval).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});
