import { APICallError } from "ai";
import { convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import {
	createStreamingMockLanguageModelV4,
	type MockLanguageModelV4StreamResult,
} from "../testing/mock-language-model-v4-test-utils";
import type { ModelAttempt, StreamAgentEvent } from "../thread/protocol/events";
import { generateModelStepResult } from "./model-step";

type MockStreamPart = MockLanguageModelV4StreamResult["stream"] extends
	ReadableStream<infer Part> ? Part
	: never;

const prompt = [{ content: "go", role: "user" }] as const;

const textChunks = (text: string) =>
	[
		{ type: "stream-start", warnings: [] },
		{ id: "text-1", type: "text-start" },
		{ delta: text, id: "text-1", type: "text-delta" },
		{ id: "text-1", type: "text-end" },
		{
			finishReason: { raw: "stop", unified: "stop" },
			type: "finish",
			usage: {
				inputTokens: {
					cacheRead: undefined,
					cacheWrite: undefined,
					noCache: undefined,
					total: 5,
				},
				outputTokens: {
					reasoning: undefined,
					text: undefined,
					total: 2,
				},
			},
		},
	] satisfies MockStreamPart[];

const attemptEvents = (events: readonly StreamAgentEvent[]): ModelAttempt[] =>
	events.filter((event): event is ModelAttempt =>
		event.type === "model-attempt"
	);

describe("model-attempt stream events", () => {
	it("emits one start and one end attempt event for a single successful call", async () => {
		const events: StreamAgentEvent[] = [];
		const model = createStreamingMockLanguageModelV4([
			{ stream: convertArrayToReadableStream(textChunks("hello")) },
		]);

		const result = await generateModelStepResult({
			history: prompt,
			model,
			onStreamEvent: (event) => {
				events.push(event);
			},
			signal: new AbortController().signal,
		});

		const attempts = attemptEvents(events);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]).toMatchObject({
			attempt: 1,
			attemptId: result.usage.attemptId,
			phase: "start",
			type: "model-attempt",
		});
		expect(attempts[1]).toMatchObject({
			attempt: 1,
			attemptId: result.usage.attemptId,
			outcome: "succeeded",
			phase: "end",
			type: "model-attempt",
		});
	});

	it("emits a second attempt when the provider retries a 429", async () => {
		const events: StreamAgentEvent[] = [];
		let calls = 0;
		const model = createStreamingMockLanguageModelV4(() => {
			calls += 1;
			if (calls === 1) {
				throw new APICallError({
					message: "rate limited",
					requestBodyValues: {},
					responseHeaders: { "retry-after": "1" },
					statusCode: 429,
					url: "https://provider.test/v1/chat",
				});
			}
			return Promise.resolve({
				stream: convertArrayToReadableStream(textChunks("recovered")),
			});
		});

		const result = await generateModelStepResult({
			history: prompt,
			model,
			onStreamEvent: (event) => {
				events.push(event);
			},
			signal: new AbortController().signal,
		});

		expect(calls).toBe(2);
		const attempts = attemptEvents(events);
		const starts = attempts.filter((event) => event.phase === "start");
		expect(starts.map((event) => event.attempt)).toEqual([1, 2]);
		expect(new Set(attempts.map((event) => event.attemptId))).toEqual(
			new Set([result.usage.attemptId]),
		);

		const failedEnd = attempts.find(
			(event) => event.phase === "end" && event.outcome === "failed",
		);
		expect(failedEnd).toMatchObject({
			attempt: 1,
			outcome: "failed",
			phase: "end",
		});

		const succeededEnd = attempts.find(
			(event) => event.phase === "end" && event.outcome === "succeeded",
		);
		expect(succeededEnd).toMatchObject({
			attempt: 2,
			outcome: "succeeded",
		});
	});

	it("classifies the failed attempt when every retry is exhausted", async () => {
		const events: StreamAgentEvent[] = [];
		const model = createStreamingMockLanguageModelV4(() => {
			throw new APICallError({
				message: "rate limited",
				requestBodyValues: {},
				responseHeaders: { "retry-after": "1" },
				statusCode: 429,
				url: "https://provider.test/v1/chat",
			});
		});

		await expect(
			generateModelStepResult({
				history: prompt,
				model,
				onStreamEvent: (event) => {
					events.push(event);
				},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();

		const attempts = attemptEvents(events);
		const starts = attempts.filter((event) => event.phase === "start");
		expect(starts.map((event) => event.attempt)).toEqual([1, 2, 3]);

		expect(attempts.at(-1)).toMatchObject({
			attempt: 3,
			error: { category: "rate-limit", status: 429 },
			outcome: "failed",
			phase: "end",
		});
	});
});
