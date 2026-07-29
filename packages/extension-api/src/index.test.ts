import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AssistantRendererRegistrationOptions,
  assistantRenderer,
  type ExtensionCapability,
  type ExtensionFactory,
  instructions,
} from "./index";

const renderer = () => ({
  invalidate() {
    return;
  },
  render() {
    return ["renderer"];
  },
  setText() {
    return;
  },
});

describe("shared extension API", () => {
  it("creates immutable instruction capabilities", () => {
    const capability = instructions("first", "second");

    expect(capability).toMatchObject({
      fragments: ["first", "second"],
      kind: "instructions",
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.fragments)).toBe(true);
  });

  it("normalizes assistant renderer registration options", () => {
    expect(assistantRenderer(renderer)).toMatchObject({
      fallback: false,
      kind: "assistant-renderer",
      override: false,
      renderer,
    });
    expect(
      assistantRenderer(renderer, {
        fallback: true,
      })
    ).toMatchObject({
      fallback: true,
      override: false,
    });
    expect(
      assistantRenderer(renderer, {
        override: true,
      })
    ).toMatchObject({
      fallback: false,
      override: true,
    });
  });

  it("keeps contradictory renderer options outside the public union", () => {
    expectTypeOf<{
      readonly fallback: true;
      readonly override: true;
    }>().not.toMatchTypeOf<AssistantRendererRegistrationOptions>();
  });

  it("supports host-supplied capability recording", () => {
    const capabilities: ExtensionCapability[] = [];
    const factory: ExtensionFactory = (pss) => {
      pss.provide(instructions("factory instruction"));
    };

    factory({
      provide(capability) {
        capabilities.push(capability);
      },
    });

    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({
      fragments: ["factory instruction"],
      kind: "instructions",
    });
  });
});
