/** @type {import("@minpeter/pss-runtime").CreateAgentOptions["model"]} */
export const echoModel = {
  doGenerate: async ({ prompt }) => ({
    content: [{ text: `echo:${lastUserText(prompt)}`, type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: emptyUsage(),
    warnings: [],
  }),
  modelId: "celld-echo",
  provider: "pss-celld-qa",
  specificationVersion: "v4",
  supportedUrls: {},
  doStream: async ({ prompt }) => ({
    stream: echoStream(lastUserText(prompt)),
  }),
};

/** @param {readonly unknown[]} prompt */
function lastUserText(prompt) {
  const message = prompt.at(-1);
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "user" ||
    !("content" in message)
  ) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  const part = message.content.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text"
  );
  return typeof part === "object" &&
    part !== null &&
    "text" in part &&
    typeof part.text === "string"
    ? part.text
    : "";
}

function emptyUsage() {
  return {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 0, total: 0 },
    outputTokens: { reasoning: 0, text: 0, total: 0 },
  };
}

/** @param {string} text */
function echoStream(text) {
  return new ReadableStream({
    start(controller) {
      const id = "echo";
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ id, type: "text-start" });
      controller.enqueue({ delta: `echo:${text}`, id, type: "text-delta" });
      controller.enqueue({ id, type: "text-end" });
      controller.enqueue({
        finishReason: { raw: "stop", unified: "stop" },
        type: "finish",
        usage: emptyUsage(),
      });
      controller.close();
    },
  });
}
