/** @typedef {{ hydratedByteLength: number, hydratedMediaType: string, promptText: string }} ModelObservations */

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
  outputTokens: { reasoning: 0, text: 0, total: 0 },
};

/**
 * Deterministic LanguageModelV4-compatible model used by the executable lane.
 * @param {ModelObservations} observations
 * @returns {import("@minpeter/pss-runtime").CreateAgentOptions["model"]}
 */
export function createDeterministicModel(observations) {
  return {
    doGenerate: ({ prompt }) => {
      const promptText = textFromPrompt(prompt);
      observations.promptText = promptText;
      recordHydratedFile(prompt, observations);
      const content = modelContent(prompt, promptText);
      return Promise.resolve({
        content,
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      });
    },
    doStream: ({ prompt }) => {
      const promptText = textFromPrompt(prompt);
      observations.promptText = promptText;
      recordHydratedFile(prompt, observations);
      return Promise.resolve({
        stream: modelStream(modelContent(prompt, promptText)),
      });
    },
    modelId: "celld-real-agent-deterministic",
    provider: "pss-celld-qa",
    specificationVersion: "v4",
    supportedUrls: {},
  };
}

/**
 * @param {readonly unknown[]} prompt
 * @param {string} text
 * @returns {Array<
 *   { readonly text: string, readonly type: "text" } |
 *   { readonly input: string, readonly toolCallId: string, readonly toolName: string, readonly type: "tool-call" }
 * >}
 */
function modelContent(prompt, text) {
  if (isCompactionPrompt(text)) {
    return [{ text: `summary:${markers(text).join(",")}`, type: "text" }];
  }
  if (text.includes("TOOL-CHECKPOINT") && !hasToolResult(prompt)) {
    return [
      {
        input: JSON.stringify({}),
        toolCallId: "checkpoint-side-effect",
        toolName: "record_side_effect",
        type: "tool-call",
      },
    ];
  }
  return [
    {
      text: `observed:${markers(text).join(",")};bytes:${new TextEncoder().encode(text).byteLength}`,
      type: "text",
    },
  ];
}

/** @param {string} text */
function isCompactionPrompt(text) {
  return text.includes("## Objective") && text.includes("continuation");
}

/** @param {string} text */
export function markers(text) {
  return [...text.matchAll(/(?:CMP-[A-C]|LARGE-\d{2})/g)]
    .map((match) => match[0])
    .filter((value, index, values) => values.indexOf(value) === index);
}

/** @param {readonly unknown[]} prompt */
function hasToolResult(prompt) {
  return prompt.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "tool"
  );
}

/** @param {readonly unknown[]} prompt */
function textFromPrompt(prompt) {
  return prompt
    .flatMap((message) =>
      typeof message === "object" && message !== null && "content" in message
        ? textFromContent(message.content)
        : []
    )
    .join("\n");
}

/** @param {unknown} content @returns {string[]} */
function textFromContent(content) {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) =>
    typeof part === "object" &&
    part !== null &&
    "text" in part &&
    typeof part.text === "string"
      ? [part.text]
      : []
  );
}

/** @param {readonly unknown[]} prompt @param {ModelObservations} observations */
function recordHydratedFile(prompt, observations) {
  for (const message of prompt) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("content" in message) ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const file = message.content.find(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "file"
    );
    if (
      typeof file === "object" &&
      file !== null &&
      "data" in file &&
      "mediaType" in file &&
      typeof file.mediaType === "string"
    ) {
      const bytes = hydratedBytes(file.data);
      if (bytes !== undefined) {
        observations.hydratedByteLength = bytes.byteLength;
        observations.hydratedMediaType = file.mediaType;
      }
    }
  }
}

/** @param {ReturnType<typeof modelContent>} content */
function modelStream(content) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      for (const part of content) {
        if (part.type === "text") {
          const id = "deterministic";
          controller.enqueue({ id, type: "text-start" });
          controller.enqueue({ delta: part.text, id, type: "text-delta" });
          controller.enqueue({ id, type: "text-end" });
          continue;
        }
        controller.enqueue({
          id: part.toolCallId,
          toolName: part.toolName,
          type: "tool-input-start",
        });
        controller.enqueue({
          delta: part.input,
          id: part.toolCallId,
          type: "tool-input-delta",
        });
        controller.enqueue({ id: part.toolCallId, type: "tool-input-end" });
        controller.enqueue(part);
      }
      const usedTool = content.some((part) => part.type === "tool-call");
      controller.enqueue({
        finishReason: usedTool
          ? { raw: "tool-calls", unified: "tool-calls" }
          : { raw: "stop", unified: "stop" },
        type: "finish",
        usage,
      });
      controller.close();
    },
  });
}

/** @param {unknown} data */
function hydratedBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "data" &&
    "data" in data
  ) {
    if (data.data instanceof Uint8Array) {
      return data.data;
    }
    if (typeof data.data === "string") {
      return Uint8Array.from(atob(data.data), (value) => value.charCodeAt(0));
    }
  }
  return;
}
