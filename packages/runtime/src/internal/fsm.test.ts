import { describe, expect, it } from "vitest";
import { Fsm, InvalidStateTransitionError } from "./fsm";

type LightState =
  | { readonly tag: "red" }
  | { readonly tag: "green" }
  | { readonly tag: "yellow"; readonly sinceMs: number };

const createLight = () =>
  new Fsm<LightState>({
    initial: { tag: "red" },
    name: "traffic-light",
    transitions: {
      red: ["green"],
      green: ["yellow"],
      yellow: ["red"],
    },
  });

describe("Fsm", () => {
  it("performs declared transitions and exposes the current state", () => {
    const light = createLight();
    expect(light.state.tag).toBe("red");

    light.to({ tag: "green" });
    light.to({ tag: "yellow", sinceMs: 42 });
    expect(light.state).toEqual({ tag: "yellow", sinceMs: 42 });

    light.to({ tag: "red" });
    expect(light.state.tag).toBe("red");
  });

  it("throws on undeclared transitions", () => {
    const light = createLight();
    expect(() => light.to({ tag: "yellow", sinceMs: 0 })).toThrow(
      InvalidStateTransitionError
    );
    expect(() => light.to({ tag: "yellow", sinceMs: 0 })).toThrow(
      '[traffic-light] invalid state transition: "red" -> "yellow"'
    );
    // State is untouched after a rejected transition.
    expect(light.state.tag).toBe("red");
  });

  it("reports membership and reachability", () => {
    const light = createLight();
    expect(light.in("red", "green")).toBe(true);
    expect(light.in("yellow")).toBe(false);
    expect(light.can("green")).toBe(true);
    expect(light.can("yellow")).toBe(false);
  });

  it("toIf only transitions from the expected state", () => {
    const light = createLight();
    expect(light.toIf("green", { tag: "yellow", sinceMs: 1 })).toBe(false);
    expect(light.state.tag).toBe("red");

    expect(light.toIf("red", { tag: "green" })).toBe(true);
    expect(light.state.tag).toBe("green");
  });

  it("expect narrows to the requested state or throws", () => {
    const light = createLight();
    light.to({ tag: "green" });
    light.to({ tag: "yellow", sinceMs: 7 });

    expect(light.expect("yellow").sinceMs).toBe(7);
    expect(() => light.expect("red")).toThrow(
      '[traffic-light] expected state "red", was "yellow"'
    );
  });
});
