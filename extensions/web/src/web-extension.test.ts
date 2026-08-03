import type {
  BaseToolCallView,
  ToolRendererMap,
} from "@minpeter/pss-coding-agent/extension";
import { createCodingAgentExtensionHost } from "@minpeter/pss-coding-agent/extension";
import type { ToolExecutionOptions } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodingAgentToolsConfigError,
  createCodingAgentTools,
  createWebExtension,
} from "./index";

const toolExecutionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "tool-call-test",
};

const createStubClient = () => ({
  fetch: vi.fn().mockResolvedValue([
    {
      content: "# Example\nReadable content.",
      length: 27,
      title: "Example",
      url: "https://example.com/",
    },
  ]),
  search: vi.fn().mockResolvedValue([
    {
      engine: "DuckDuckGo",
      snippet: "Typed JavaScript at scale.",
      title: "TypeScript",
      url: "https://www.typescriptlang.org/",
    },
  ]),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web extension tools", () => {
  it("registers web tools and their renderers as extension capabilities", async () => {
    const host = await createCodingAgentExtensionHost([
      { default: createWebExtension(), id: "web" },
    ]);

    expect(Object.keys(host.tools)).toStrictEqual(["web_search", "web_fetch"]);
    expect(Object.keys(host.toolRenderers)).toStrictEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(host.getToolOwner("web_search")).toBe("web");
    expect(host.getToolRendererOwner("web_fetch")).toBe("web");
    await host.dispose();
  });

  it("registers nothing when web tools are disabled", async () => {
    const host = await createCodingAgentExtensionHost([
      {
        default: createWebExtension({ webToolsAvailability: "disabled" }),
        id: "web",
      },
    ]);

    expect(host.tools).toStrictEqual({});
    expect(host.toolRenderers).toStrictEqual({});
    await host.dispose();
  });

  it("executes web_search and web_fetch through the injected client", async () => {
    const client = createStubClient();
    const definitions = createCodingAgentTools({ client });
    const search = definitions.web_search.execute;
    const fetch = definitions.web_fetch.execute;
    if (typeof search !== "function" || typeof fetch !== "function") {
      throw new TypeError("Expected executable web tools");
    }

    await search(
      { numResults: 3, query: "typescript docs" },
      toolExecutionOptions
    );
    await fetch(
      { maxCharacters: 8000, urls: ["https://example.com/"] },
      toolExecutionOptions
    );

    expect(client.search).toHaveBeenCalledWith("typescript docs", 3);
    expect(client.fetch).toHaveBeenCalledWith(["https://example.com/"], {
      maxCharacters: 8000,
    });
  });

  it("rejects conflicting client configuration", () => {
    expect(() =>
      createCodingAgentTools({
        client: createStubClient(),
        openSearchOptions: {},
      })
    ).toThrowError(CodingAgentToolsConfigError);
  });
});

interface CapturedBlock {
  readonly body: string;
  readonly header: string;
}

const render = (
  renderer: ToolRendererMap[string],
  input: unknown,
  output: unknown
): CapturedBlock => {
  let captured: CapturedBlock | undefined;
  const view = {
    getError: () => undefined,
    setPrettyBlock: (header: string, body: string) => {
      captured = { body, header };
    },
  } as unknown as BaseToolCallView;
  renderer(view, input, output);
  if (captured === undefined) {
    throw new Error("Renderer did not claim the tool output");
  }
  return captured;
};

describe("web extension renderers", () => {
  it("renders search results and truncates fetched page bodies", async () => {
    const host = await createCodingAgentExtensionHost([
      { default: createWebExtension(), id: "web" },
    ]);
    const searchRenderer = host.toolRenderers.web_search;
    const fetchRenderer = host.toolRenderers.web_fetch;
    if (searchRenderer === undefined || fetchRenderer === undefined) {
      throw new Error("Expected web renderers");
    }

    const search = render(searchRenderer, { query: "pnpm catalogs" }, [
      {
        snippet: "Catalogs allow sharing versions",
        title: "Catalogs | pnpm",
        url: "https://pnpm.io/catalogs",
      },
    ]);
    expect(search.header).toContain("pnpm catalogs");
    expect(search.body).toContain("1. Catalogs | pnpm");
    expect(search.body).toContain("https://pnpm.io/catalogs");

    const longText = `intro\n${"x".repeat(5000)}`;
    const fetched = render(fetchRenderer, { urls: ["https://a.dev"] }, [
      {
        content: longText,
        title: "Page A",
        url: "https://a.dev",
      },
    ]);
    expect(fetched.body).toContain("Page A");
    expect(fetched.body).toContain("truncated");
    expect(fetched.body.length).toBeLessThan(4000);
    await host.dispose();
  });
});
