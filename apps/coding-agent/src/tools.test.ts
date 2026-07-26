import type { ToolExecutionOptions } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodingAgentToolsConfigError,
  createCodingAgentTools,
  resolveStartTuiTools,
} from "./tools";

const toolExecutionOptions: ToolExecutionOptions<Record<string, unknown>> = {
  context: {},
  messages: [],
  toolCallId: "tool-call-test",
};

const searchResult = {
  engine: "DuckDuckGo",
  snippet: "Typed JavaScript at scale.",
  title: "TypeScript",
  url: "https://www.typescriptlang.org/",
};

const fetchResult = {
  content: "# Example\nReadable content.",
  length: 27,
  title: "Example",
  url: "https://example.com/",
};

function createStubClient() {
  return {
    fetch: vi.fn().mockResolvedValue([fetchResult]),
    search: vi.fn().mockResolvedValue([searchResult]),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("coding-agent web tools", () => {
  it("creates OpenSearch-backed web_search and web_fetch tools", async () => {
    const client = createStubClient();

    const tools = createCodingAgentTools({ client });
    const searchExecute = tools.web_search.execute;
    const fetchExecute = tools.web_fetch.execute;

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
    expect(typeof searchExecute).toBe("function");
    expect(typeof fetchExecute).toBe("function");
    if (
      typeof searchExecute !== "function" ||
      typeof fetchExecute !== "function"
    ) {
      throw new TypeError("Expected executable web tools.");
    }

    await expect(
      searchExecute(
        { numResults: 3, query: "typescript docs" },
        toolExecutionOptions
      )
    ).resolves.toStrictEqual([searchResult]);
    await expect(
      fetchExecute(
        { maxCharacters: 8000, urls: ["https://example.com/"] },
        toolExecutionOptions
      )
    ).resolves.toStrictEqual([fetchResult]);
    expect(client.search).toHaveBeenCalledWith("typescript docs", 3);
    expect(client.fetch).toHaveBeenCalledWith(["https://example.com/"], {
      maxCharacters: 8000,
    });
  });

  it("uses OpenSearch tools by default for the TUI and preserves overrides", () => {
    const defaultTools = resolveStartTuiTools();
    const overrideTools = { custom_tool: defaultTools.web_search };

    expect(Object.keys(defaultTools)).toStrictEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(resolveStartTuiTools(overrideTools)).toBe(overrideTools);
  });

  it("rejects providing both client and openSearchOptions", () => {
    expect(() =>
      createCodingAgentTools({
        client: createStubClient(),
        openSearchOptions: {},
      })
    ).toThrowError(CodingAgentToolsConfigError);
  });
});

describe("web tools availability modes", () => {
  it("registers web tools by default without any provider API key", () => {
    vi.stubEnv("TINYFISH_API_KEY", undefined);

    const tools = createCodingAgentTools();

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("registers web tools in required mode without any provider API key", () => {
    vi.stubEnv("TINYFISH_API_KEY", undefined);

    const tools = createCodingAgentTools({
      webToolsAvailability: "required",
    });

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("registers web tools with an OpenSearch env override", () => {
    const tools = createCodingAgentTools({
      openSearchOptions: { env: { TINYFISH_API_KEY: "test-key" } },
    });

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("never registers web tools in disabled mode", () => {
    const tools = createCodingAgentTools({
      openSearchOptions: { env: { TINYFISH_API_KEY: "test-key" } },
      webToolsAvailability: "disabled",
    });

    expect(Object.keys(tools)).toStrictEqual([]);
  });

  it("omits web tools in disabled mode even with an injected client", () => {
    const tools = createCodingAgentTools({
      client: createStubClient(),
      webToolsAvailability: "disabled",
    });

    expect(Object.keys(tools)).toStrictEqual([]);
  });
});

describe("resolveStartTuiTools availability", () => {
  it("starts the TUI with web tools even without a provider API key", () => {
    vi.stubEnv("TINYFISH_API_KEY", undefined);

    const tools = resolveStartTuiTools();

    expect(Object.keys(tools)).toStrictEqual(["web_search", "web_fetch"]);
  });

  it("omits TUI web tools in disabled mode", () => {
    const tools = resolveStartTuiTools(undefined, {
      webToolsAvailability: "disabled",
    });

    expect(Object.keys(tools)).toStrictEqual([]);
  });

  it("returns override tools unchanged regardless of availability mode", () => {
    const overrideTools = {};

    expect(
      resolveStartTuiTools(overrideTools, { webToolsAvailability: "required" })
    ).toBe(overrideTools);
  });
});
