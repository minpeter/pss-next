import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import {
  assistantRenderer,
  command,
  extensionCapabilityBrand,
  instructions,
  threadMigration,
  toolRenderer,
  tools,
} from "./capabilities";
import { createCodingAgentExtensionHost } from "./host";
import type { CodingAgentExtensionModule } from "./types";

const qaTool = tool({
  description: "Capability QA tool",
  inputSchema: jsonSchema({
    additionalProperties: false,
    type: "object",
  }),
});

describe("coding-agent extension capabilities", () => {
  it("brands every capability factory consistently", () => {
    const capability = tools({ qa_tool: qaTool });

    expect(capability[extensionCapabilityBrand]).toBe(true);
    expect(Reflect.ownKeys(capability)).toContain(extensionCapabilityBrand);
  });
  it("creates immutable instruction capabilities", () => {
    const capability = instructions("first", "second");

    expect(capability).toMatchObject({
      fragments: ["first", "second"],
      kind: "instructions",
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.fragments)).toBe(true);
    expect(capability[extensionCapabilityBrand]).toBe(true);
  });

  it("normalizes assistant renderer registration options", () => {
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

    expect(assistantRenderer(renderer)).toMatchObject({
      fallback: false,
      mode: "exclusive",
      override: false,
      renderer,
    });
    expect(assistantRenderer(renderer, { mode: "fallback" })).toMatchObject({
      fallback: true,
      mode: "fallback",
      override: false,
    });
    expect(assistantRenderer(renderer, { mode: "override" })).toMatchObject({
      fallback: false,
      mode: "override",
      override: true,
    });
    // Deprecated boolean forms remain runtime-compatible.
    expect(assistantRenderer(renderer, { fallback: true }).mode).toBe(
      "fallback"
    );
    expect(assistantRenderer(renderer, { override: true }).mode).toBe(
      "override"
    );
  });

  it("rejects malformed renderer options through factory and legacy registry paths", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return [];
      },
      setText() {
        return;
      },
    });
    const malformed = [
      { fallback: true, mode: "fallback" },
      { fallback: true, override: true },
      { mode: "replace" },
      { fallback: false },
    ] as const;

    for (const options of malformed) {
      expect(() => assistantRenderer(renderer, options as never)).toThrow(
        TypeError
      );
      await expect(
        createCodingAgentExtensionHost([
          {
            configure(registry) {
              registry.tui.registerAssistantRenderer(
                renderer,
                options as never
              );
            },
            id: "malformed-renderer-options",
          },
        ])
      ).rejects.toMatchObject({ cause: expect.any(TypeError) });
    }
  });

  it("registers one assistant renderer through the capability API", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["assistant renderer"];
      },
      setText() {
        return;
      },
    });
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(assistantRenderer(renderer));
        },
        id: "assistant-renderer",
      },
    ]);

    expect(host.assistantRenderer).toBe(renderer);
    expect(host.getAssistantRendererOwner()).toBe("assistant-renderer");
    await host.dispose();
  });

  it("rejects conflicting assistant renderers", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return [];
      },
      setText() {
        return;
      },
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer));
          },
          id: "first-renderer",
        },
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer));
          },
          id: "second-renderer",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Assistant renderer from extension "second-renderer" conflicts with extension "first-renderer"',
      },
    });
  });

  it("lets a default assistant renderer replace a bundled fallback", async () => {
    const fallback = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["fallback"];
      },
      setText() {
        return;
      },
    });
    const preferred = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["preferred"];
      },
      setText() {
        return;
      },
    });
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(assistantRenderer(fallback, { fallback: true }));
        },
        id: "bundled-fallback",
      },
      {
        default(pss) {
          pss.provide(assistantRenderer(preferred, { override: true }));
        },
        id: "preferred-renderer",
      },
    ]);

    expect(host.assistantRenderer).toBe(preferred);
    expect(host.getAssistantRendererOwner()).toBe("preferred-renderer");
    await host.dispose();
  });

  it("requires explicit intent to replace a bundled fallback", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return [];
      },
      setText() {
        return;
      },
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer, { fallback: true }));
          },
          id: "bundled-fallback",
        },
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer));
          },
          id: "implicit-replacement",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Assistant renderer from extension "implicit-replacement" conflicts with extension "bundled-fallback"; register with { override: true } to replace the fallback',
      },
    });
  });

  it("composes fallback assistant renderers in registration order", async () => {
    const wrapRenderer =
      (name: string) =>
      ({
        delegate,
      }: {
        delegate?: (text: string) => { render(width: number): string[] };
      }) => {
        let text = "";
        return {
          invalidate() {
            return;
          },
          render(width: number) {
            const inner = delegate?.(`${name}(${text})`);
            return inner === undefined
              ? [`${name}(${text})`]
              : inner.render(width);
          },
          setText(value: string) {
            text = value;
          },
        };
      };
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(
            assistantRenderer(wrapRenderer("first"), { fallback: true })
          );
        },
        id: "first-fallback",
      },
      {
        default(pss) {
          pss.provide(
            assistantRenderer(wrapRenderer("second"), { fallback: true })
          );
        },
        id: "second-fallback",
      },
    ]);

    expect(host.getAssistantRendererChainOwners()).toEqual([
      "first-fallback",
      "second-fallback",
    ]);
    expect(host.getAssistantRendererOwner()).toBe("second-fallback");

    const markdownTheme = new Proxy(
      {},
      { get: () => (text: string) => text }
    ) as never;
    const view = host.assistantRenderer?.({
      markdownTheme,
      notify: () => undefined,
      notifyOnce: () => undefined,
      requestRender: () => undefined,
      signal: new AbortController().signal,
    });
    view?.setText("hello");
    // The last registered fallback ("second") is outermost: it processes the
    // raw text first, then "first" wraps the result.
    expect(view?.render(80).join("\n")).toContain("first(second(hello))");
    await host.dispose();
  });

  it("rejects a fallback once an override owns the renderer slot", async () => {
    const renderer = () => ({
      invalidate() {
        return;
      },
      render() {
        return [];
      },
      setText() {
        return;
      },
    });

    await expect(
      createCodingAgentExtensionHost([
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer, { override: true }));
          },
          id: "override-owner",
        },
        {
          default(pss) {
            pss.provide(assistantRenderer(renderer, { fallback: true }));
          },
          id: "late-fallback",
        },
      ])
    ).rejects.toMatchObject({
      cause: {
        message:
          'Assistant renderer from extension "late-fallback" conflicts with extension "override-owner"',
      },
    });
  });

  it("lets an override replace a composed fallback chain", async () => {
    const fallback = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["fallback"];
      },
      setText() {
        return;
      },
    });
    const preferred = () => ({
      invalidate() {
        return;
      },
      render() {
        return ["preferred"];
      },
      setText() {
        return;
      },
    });
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(assistantRenderer(fallback, { fallback: true }));
        },
        id: "first-fallback",
      },
      {
        default(pss) {
          pss.provide(assistantRenderer(fallback, { fallback: true }));
        },
        id: "second-fallback",
      },
      {
        default(pss) {
          pss.provide(assistantRenderer(preferred, { override: true }));
        },
        id: "preferred-renderer",
      },
    ]);

    expect(host.assistantRenderer).toBe(preferred);
    expect(host.getAssistantRendererOwner()).toBe("preferred-renderer");
    expect(host.getAssistantRendererChainOwners()).toEqual([]);
    await host.dispose();
  });

  it("exposes only the three factory composition methods", async () => {
    let keys: string[] = [];
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          keys = Object.keys(pss).sort();
        },
        id: "minimal-surface",
      },
    ]);

    try {
      expect(keys).toEqual(["on", "provide", "use"]);
    } finally {
      await host.dispose();
    }
  });

  it("publishes every capability kind through provide", async () => {
    const renderer = () => undefined;
    const host = await createCodingAgentExtensionHost([
      {
        default(pss) {
          pss.provide(instructions("Capability instruction"));
          pss.provide(tools({ capability_tool: qaTool }));
          pss.provide(
            command({
              aliases: ["cap"],
              description: "Inspect capabilities",
              execute: () => ({ success: true }),
              name: "capability",
            })
          );
          pss.provide(
            threadMigration({
              id: "sanitize",
              migrate: (snapshot) => snapshot,
              version: 1,
            })
          );
          pss.provide(toolRenderer("capability_tool", renderer));
        },
        id: "capability-provider",
      },
    ]);

    try {
      expect(host.instructionFragments).toEqual(["Capability instruction"]);
      expect(Object.keys(host.tools)).toEqual(["capability_tool"]);
      expect(host.commands.map(({ name }) => name)).toEqual(["capability"]);
      expect(host.threadMigrations.map(({ id }) => id)).toEqual([
        "capability-provider/sanitize",
      ]);
      expect(host.toolRenderers.capability_tool).toBe(renderer);
    } finally {
      await host.dispose();
    }
  });

  it("registers activation and reverse cleanup through on", async () => {
    const lifecycle: string[] = [];
    const extensionModule: CodingAgentExtensionModule = {
      default(pss) {
        const on = pss.on as (
          type: "activate",
          handler: (context: { readonly mode: string }) => () => void
        ) => void;
        on("activate", ({ mode }) => {
          lifecycle.push(`first:${mode}`);
          return () => lifecycle.push("cleanup:first");
        });
        on("activate", () => {
          lifecycle.push("second");
          return () => lifecycle.push("cleanup:second");
        });
      },
      id: "activation-provider",
    };
    const host = await createCodingAgentExtensionHost([extensionModule]);
    const agent = await createAgent({
      model: createOpenAICompatible({
        apiKey: "test-key",
        baseURL: "https://example.invalid/v1",
        name: "capability-test",
      })("test-model"),
    });

    try {
      await host.activate(agent, "exec");
    } finally {
      await host.dispose();
      await agent.dispose();
    }

    expect(lifecycle).toEqual([
      "first:exec",
      "second",
      "cleanup:second",
      "cleanup:first",
    ]);
  });

  it("snapshots commands instead of retaining extension containers", async () => {
    const aliases = ["before-alias"];
    const command = {
      aliases,
      description: "Before",
      execute: () => ({ success: true }),
      name: "before",
    };
    const host = await createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register(command);
        },
        id: "snapshot-provider",
      },
    ]);

    command.name = "after";
    command.description = "After";
    aliases[0] = "after-alias";

    try {
      expect(host.commands[0]).toMatchObject({
        aliases: ["before-alias"],
        description: "Before",
        name: "before",
      });
    } finally {
      await host.dispose();
    }
  });

  it("rejects duplicate command aliases before publication", async () => {
    const creation = createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register({
            aliases: ["shared"],
            description: "First",
            execute: () => ({ success: true }),
            name: "first",
          });
          registry.commands.register({
            aliases: ["shared"],
            description: "Second",
            execute: () => ({ success: true }),
            name: "second",
          });
        },
        id: "alias-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });

    await expect(creation).rejects.toMatchObject({
      cause: {
        message:
          'Command name or alias "shared" from extension "alias-provider" conflicts with extension "alias-provider"',
      },
    });
  });

  it("rejects extension commands that shadow built-ins", async () => {
    const creation = createCodingAgentExtensionHost([
      {
        configure(registry) {
          registry.commands.register({
            description: "Override clear",
            execute: () => ({ success: true }),
            name: "clear",
          });
        },
        id: "builtin-shadow-provider",
      },
    ]).then(async (host) => {
      await host.dispose();
      return host;
    });

    await expect(creation).rejects.toMatchObject({
      cause: {
        message: 'Reserved coding agent command name or alias "clear"',
      },
    });
  });
});
