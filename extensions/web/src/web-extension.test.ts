import type {
  BaseToolCallView,
  ToolRendererMap,
} from "@minpeter/pss-coding-agent/extension";
import { createCodingAgentExtensionHost } from "@minpeter/pss-coding-agent/extension";
import { asSchema, type ToolExecutionOptions } from "ai";
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const rejectWhenAborted = (signal: AbortSignal | undefined): Promise<never> => {
  if (signal === undefined) {
    return Promise.reject(new Error("Expected client abort signal"));
  }

  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
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

  it("aborts an in-flight web_search client call", async () => {
    const client = createStubClient();
    client.search.mockImplementation((_query, _maxResults, options) =>
      rejectWhenAborted(options?.signal)
    );
    const search = createCodingAgentTools({ client }).web_search.execute;
    if (typeof search !== "function") {
      throw new TypeError("Expected executable web_search tool");
    }
    const controller = new AbortController();
    const reason = new Error("stop search");

    const execution = search(
      { query: "typescript docs" },
      { ...toolExecutionOptions, abortSignal: controller.signal }
    );
    controller.abort(reason);

    await expect(execution).rejects.toBe(reason);
    expect(client.search).toHaveBeenCalledWith("typescript docs", 5, {
      signal: controller.signal,
    });
  });

  it("aborts an in-flight web_fetch client call", async () => {
    const client = createStubClient();
    client.fetch.mockImplementation((_urls, options) =>
      rejectWhenAborted(options?.signal)
    );
    const fetch = createCodingAgentTools({ client }).web_fetch.execute;
    if (typeof fetch !== "function") {
      throw new TypeError("Expected executable web_fetch tool");
    }
    const controller = new AbortController();
    const reason = new Error("stop fetch");

    const execution = fetch(
      { urls: ["https://example.com/"] },
      { ...toolExecutionOptions, abortSignal: controller.signal }
    );
    controller.abort(reason);

    await expect(execution).rejects.toBe(reason);
    expect(client.fetch).toHaveBeenCalledWith(["https://example.com/"], {
      signal: controller.signal,
    });
  });

  it("aborts the default search client's underlying request", async () => {
    const started = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        started.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true }
          );
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new Error("stop default search");
    const search = createCodingAgentTools({
      openSearchOptions: {
        env: { TAVILY_API_KEY: "test-key" },
        search: { cache: { enabled: false } },
      },
    }).web_search.execute;
    if (typeof search !== "function") {
      throw new TypeError("Expected executable web_search tool");
    }

    const result = search(
      { query: "abort default search" },
      { ...toolExecutionOptions, abortSignal: controller.signal }
    );
    await started.promise;
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the default fetch client's underlying request", async () => {
    const started = deferred<void>();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        started.resolve();
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true }
          );
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new Error("stop default fetch");
    const fetch = createCodingAgentTools({
      openSearchOptions: { fetch: { cache: { enabled: false } } },
    }).web_fetch.execute;
    if (typeof fetch !== "function") {
      throw new TypeError("Expected executable web_fetch tool");
    }

    const result = fetch(
      { urls: ["https://news.ycombinator.com/item?id=123"] },
      { ...toolExecutionOptions, abortSignal: controller.signal }
    );
    await started.promise;
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid model inputs before calling the client", async () => {
    const client = createStubClient();
    const definitions = createCodingAgentTools({ client });
    const searchSchema = asSchema(definitions.web_search.inputSchema);
    const fetchSchema = asSchema(definitions.web_fetch.inputSchema);

    await expect(
      searchSchema.validate?.({ numResults: 99, query: "" })
    ).resolves.toMatchObject({ success: false });
    await expect(
      fetchSchema.validate?.({ maxCharacters: -1, urls: [] })
    ).resolves.toMatchObject({ success: false });
    await expect(
      fetchSchema.validate?.({ urls: ["file:///etc/passwd"] })
    ).resolves.toMatchObject({ success: false });
    expect(client.search).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
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
