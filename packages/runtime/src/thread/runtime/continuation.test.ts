import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../agent/core/agent";
import {
  assistantMessage,
  committedEvents,
  createCallbackModel,
  sentUserText,
  steerRuntimeInput,
  userText,
} from "../../testing/test-fixtures";
import {
  solidTestPng,
  solidTestPngBase64,
} from "../../testing/valid-image-fixture";
import { isRuntimeAttachmentData } from "../input/attachments";
import type { AgentEvent } from "../protocol/events";
import { userTextToModelMessage } from "../protocol/mapping";

describe("Agent thread runtime input continuation", () => {
  it("active thread.steer at step-end continues the current turn with appended user input", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(calls === 1 ? "This could be final." : "DONE"),
        ]);
      }),
    });
    const thread = agent.thread("step-end-steer");
    const run = await thread.send("initial user");
    const events: AgentEvent[] = [];
    let injected = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "step-end" && !injected) {
        injected = true;
        await thread.steer("extra");
      }
    }

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("initial user"))],
      [
        userTextToModelMessage(userText("initial user")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("extra")),
      ],
    ]);
    expect(committedEvents(events)).toEqual([
      sentUserText("initial user"),
      { type: "turn-start" },
      { type: "step-start" },
      expect.objectContaining({ type: "model-usage" }),
      { type: "assistant-output", text: "This could be final." },
      { type: "step-end" },
      steerRuntimeInput("extra", "step-end"),
      { type: "step-start" },
      expect.objectContaining({ type: "model-usage" }),
      { type: "assistant-output", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("normalizes multipart image file thread.steer input like thread.send", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    });
    const input = [
      { type: "text", text: "describe this" },
      { type: "file", data: solidTestPngBase64(), mediaType: "image/png" },
      {
        type: "file",
        data: { type: "text", text: "inline document" },
        filename: "note.txt",
        mediaType: "text/plain",
      },
    ] as const;
    const thread = agent.thread("multipart-steer");
    const run = await thread.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await thread.steer(input);
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    const runtimeInput = runtimeInputs[0];
    if (runtimeInput?.type !== "runtime-input") {
      throw new Error("expected runtime input event");
    }
    expect(runtimeInput.placement).toBe("step-start");
    expect(runtimeInput.meta).toEqual({
      source: "steer",
      streaming: "steer",
    });
    if (!("content" in runtimeInput.input)) {
      throw new Error("expected multipart runtime input");
    }
    expect(runtimeInput.input.content[0]).toEqual({
      text: "describe this",
      type: "text",
    });
    const runtimeImageFilePart = runtimeInput.input.content[1];
    expect(runtimeImageFilePart?.type).toBe("file");
    if (runtimeImageFilePart?.type !== "file") {
      throw new Error("expected staged file part");
    }
    expect(isRuntimeAttachmentData(runtimeImageFilePart.data)).toBe(true);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        {
          content: [
            {
              providerOptions: undefined,
              text: "describe this",
              type: "text",
            },
            {
              data: solidTestPng(),
              filename: undefined,
              mediaType: "image/png",
              providerOptions: undefined,
              type: "file",
            },
            {
              data: { type: "text", text: "inline document" },
              filename: "note.txt",
              mediaType: "text/plain",
              providerOptions: undefined,
              type: "file",
            },
          ],
          providerOptions: undefined,
          role: "user",
        },
      ],
    ]);
  });
});
