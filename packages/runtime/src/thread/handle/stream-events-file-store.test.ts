import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { jsonSchema, tool } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import { createFileHost } from "../../platform/file/host/file-host";
import {
  currentDataDirectory,
  tempDir,
} from "../../platform/file/storage/file-execution-store-test-support";
import {
  createStreamingMockLanguageModelV4,
  type MockLanguageModelV4StreamResult,
} from "../../testing/mock-language-model-v4-test-utils";
import { type AgentEvent, isStreamAgentEvent } from "../protocol/events";
import { collect } from "./test-support";

type MockStreamPart =
  MockLanguageModelV4StreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const STREAM_EVENT_TYPES = [
  "assistant-output-delta",
  "assistant-reasoning-delta",
  "tool-call-input-start",
  "tool-call-input-delta",
  "tool-call-input-end",
] as const;

const lookupTool = tool({
  execute: () => ({ weather: "sunny" }),
  inputSchema: jsonSchema({
    additionalProperties: false,
    properties: { city: { type: "string" } },
    required: ["city"],
    type: "object",
  }),
});
const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: 1,
  },
  outputTokens: { reasoning: 1, text: 2, total: 3 },
};
const toolInput = JSON.stringify({ city: "Seoul" });

const firstStreamChunks = [
  { type: "stream-start", warnings: [] },
  { id: "text-1", type: "text-start" },
  { delta: "hello ", id: "text-1", type: "text-delta" },
  { delta: "world", id: "text-1", type: "text-delta" },
  { id: "text-1", type: "text-end" },
  { id: "reasoning-1", type: "reasoning-start" },
  { delta: "thinking", id: "reasoning-1", type: "reasoning-delta" },
  { id: "reasoning-1", type: "reasoning-end" },
  { id: "call-1", toolName: "lookup", type: "tool-input-start" },
  { delta: toolInput, id: "call-1", type: "tool-input-delta" },
  { id: "call-1", type: "tool-input-end" },
  {
    input: toolInput,
    toolCallId: "call-1",
    toolName: "lookup",
    type: "tool-call",
  },
  {
    finishReason: { raw: "tool-calls", unified: "tool-calls" },
    type: "finish",
    usage,
  },
] satisfies MockStreamPart[];

const finalStreamChunks = [
  { type: "stream-start", warnings: [] },
  {
    finishReason: { raw: "stop", unified: "stop" },
    type: "finish",
    usage,
  },
] satisfies MockStreamPart[];

const tempDirectories: string[] = [];

afterEach(async () => {
  const pending = tempDirectories.splice(0);
  await Promise.all(
    pending.map((directory) =>
      rm(directory, { force: true, maxRetries: 10, recursive: true })
    )
  );
});

describe("thread stream events with the file execution store", () => {
  it("persists zero stream deltas while retaining committed events", async () => {
    const directory = await tempDir();
    tempDirectories.push(directory);
    const threadKey = "stream-file-store";
    const thread = new Agent({
      host: createFileHost({ directory }),
      model: createStreamingMockLanguageModelV4([
        { stream: convertArrayToReadableStream(firstStreamChunks) },
        { stream: convertArrayToReadableStream(finalStreamChunks) },
      ]),
      tools: { lookup: lookupTool },
    }).thread(threadKey);

    const live = await collect(await thread.send("go"));

    const liveTypes = live.map((event) => event.type);
    for (const streamType of STREAM_EVENT_TYPES) {
      expect(liveTypes).toContain(streamType);
    }
    expect(live.some((event) => isStreamAgentEvent(event))).toBe(true);

    const persisted = await readPersistedThreadEvents(directory, threadKey);
    const persistedTypes = persisted.map((event) => event.type);

    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.some((event) => isStreamAgentEvent(event))).toBe(false);
    for (const streamType of STREAM_EVENT_TYPES) {
      expect(persistedTypes).not.toContain(streamType);
    }
    expect(persistedTypes).toEqual(
      expect.arrayContaining([
        "user-input",
        "turn-start",
        "assistant-reasoning",
        "assistant-output",
        "tool-call",
        "tool-result",
        "turn-end",
      ])
    );
    expect(persistedTypes).toEqual(
      live.filter((event) => !isStreamAgentEvent(event)).map((e) => e.type)
    );
  });
});

async function readPersistedThreadEvents(
  directory: string,
  threadKey: string
): Promise<AgentEvent[]> {
  const threadEventsDirectory = join(
    await currentDataDirectory(directory),
    "thread-events"
  );
  const files = await readdir(threadEventsDirectory);
  expect(files).toEqual([
    `${Buffer.from(threadKey).toString("base64url")}.jsonl`,
  ]);
  const content = await readFile(
    join(threadEventsDirectory, files[0] as string),
    "utf8"
  );
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { event: AgentEvent }).event);
}
