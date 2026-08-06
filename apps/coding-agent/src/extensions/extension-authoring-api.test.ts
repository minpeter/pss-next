import { describe, expect, expectTypeOf, it } from "vitest";
import { instructions } from "./capabilities";
import { defineLegacyCodingAgentExtension } from "./legacy";
import {
  type CodingAgentExtensionEvents,
  type CodingAgentExtensionFactory,
  defineCodingAgentExtension,
} from "./types";

describe("extension authoring API compatibility", () => {
  it("keeps factory authoring canonical and legacy registry objects available", () => {
    const factory = defineCodingAgentExtension((pss) => {
      pss.provide(instructions("canonical"));
    });
    const legacy = defineLegacyCodingAgentExtension({
      configure(registry) {
        registry.instructions.append("legacy");
      },
      id: "legacy-extension",
    });

    expectTypeOf(factory).toEqualTypeOf<CodingAgentExtensionFactory>();
    expect(typeof factory).toBe("function");
    expect(legacy.id).toBe("legacy-extension");
  });

  it("supports typed event maps while retaining arbitrary JSON events", () => {
    interface Events {
      readonly "checkpoint:saved": { readonly revision: number };
    }
    const events = null as unknown as CodingAgentExtensionEvents<Events>;

    expectTypeOf<CodingAgentExtensionEvents<Events>["emit"]>().toBeFunction();
    expectTypeOf<CodingAgentExtensionEvents<Events>["on"]>().toBeFunction();
    // Compile-time contract: named events infer their declared payload.
    const checkContract = (typedEvents: CodingAgentExtensionEvents<Events>) => {
      typedEvents.emit("checkpoint:saved", { revision: 7 });
      typedEvents.on("checkpoint:saved", (payload) => {
        expectTypeOf(payload.revision).toEqualTypeOf<number>();
      });
    };
    expectTypeOf(checkContract).toBeFunction();
    expect(events).toBeNull();
  });
});
