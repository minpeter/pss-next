import type { LanguageModel, LanguageModelUsage } from "ai";
import type { ModelUsage } from "../thread/protocol/events";

const SAFE_TELEMETRY_IDENTIFIER_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/u;
const FINISH_REASONS = new Set<ModelUsage["finishReason"]>([
	"content-filter",
	"error",
	"length",
	"other",
	"stop",
	"tool-calls",
]);

export function modelUsageEvent({
	attemptId,
	durationMs,
	finishReason,
	modelId,
	provider,
	usage,
}: {
	readonly attemptId: string;
	readonly durationMs?: number;
	readonly finishReason?: ModelUsage["finishReason"];
	readonly modelId?: string;
	readonly provider?: string;
	readonly usage?: LanguageModelUsage;
}): ModelUsage {
	const { cacheReadTokens, cacheWriteTokens, noCacheTokens } =
		usage?.inputTokenDetails ?? {};
	const { reasoningTokens } = usage?.outputTokenDetails ?? {};
	const { inputTokens, outputTokens, totalTokens } = usage ?? {};
	const normalized = {
		cacheReadTokens: safeTokenCount(cacheReadTokens),
		cacheWriteTokens: safeTokenCount(cacheWriteTokens),
		durationMs: safeDuration(durationMs),
		finishReason: safeFinishReason(finishReason),
		inputTokens: safeTokenCount(inputTokens),
		modelId: safeTelemetryIdentifier(modelId),
		noCacheTokens: safeTokenCount(noCacheTokens),
		outputTokens: safeTokenCount(outputTokens),
		provider: safeTelemetryIdentifier(provider),
		reasoningTokens: safeTokenCount(reasoningTokens),
		totalTokens: safeTokenCount(totalTokens),
	};

	return {
		attemptId,
		...(normalized.cacheReadTokens === undefined
			? {}
			: { cacheReadTokens: normalized.cacheReadTokens }),
		...(normalized.cacheWriteTokens === undefined
			? {}
			: { cacheWriteTokens: normalized.cacheWriteTokens }),
		...(normalized.durationMs === undefined
			? {}
			: { durationMs: normalized.durationMs }),
		...(normalized.finishReason === undefined
			? {}
			: { finishReason: normalized.finishReason }),
		...(normalized.inputTokens === undefined
			? {}
			: { inputTokens: normalized.inputTokens }),
		...(normalized.modelId === undefined
			? {}
			: { modelId: normalized.modelId }),
		...(normalized.noCacheTokens === undefined
			? {}
			: { noCacheTokens: normalized.noCacheTokens }),
		...(normalized.outputTokens === undefined
			? {}
			: { outputTokens: normalized.outputTokens }),
		...(normalized.provider === undefined
			? {}
			: { provider: normalized.provider }),
		...(normalized.reasoningTokens === undefined
			? {}
			: { reasoningTokens: normalized.reasoningTokens }),
		...(normalized.totalTokens === undefined
			? {}
			: { totalTokens: normalized.totalTokens }),
		type: "model-usage",
	};
}

export function configuredModelId(model: LanguageModel): string | undefined {
	return typeof model === "string"
		? model
		: dataPropertyStringInPrototypeChain(model, "modelId");
}

export function configuredProvider(model: LanguageModel): string | undefined {
	return typeof model === "string"
		? undefined
		: dataPropertyStringInPrototypeChain(model, "provider");
}

export function firstSafeTelemetryIdentifier(
	...values: readonly unknown[]
): string | undefined {
	for (const value of values) {
		const safe = safeTelemetryIdentifier(value);
		if (safe !== undefined) {
			return safe;
		}
	}
	return;
}

function safeTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) &&
			value >= 0
		? value
		: undefined;
}

function safeDuration(value: unknown): number | undefined {
	if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
		return;
	}
	const rounded = Math.round(value);
	return Number.isSafeInteger(rounded) ? rounded : undefined;
}

function safeFinishReason(
	value: unknown,
): ModelUsage["finishReason"] | undefined {
	return typeof value === "string" &&
			FINISH_REASONS.has(value as ModelUsage["finishReason"])
		? (value as ModelUsage["finishReason"])
		: undefined;
}

export function safeTelemetryIdentifier(value: unknown): string | undefined {
	return typeof value === "string" &&
			SAFE_TELEMETRY_IDENTIFIER_PATTERN.test(value)
		? value
		: undefined;
}

function dataPropertyStringInPrototypeChain(
	value: object,
	property: string,
): string | undefined {
	try {
		let current: object | null = value;
		while (current !== null) {
			const descriptor = Object.getOwnPropertyDescriptor(
				current,
				property,
			);
			if (descriptor) {
				return "value" in descriptor &&
						typeof descriptor.value === "string"
					? descriptor.value
					: undefined;
			}
			current = Object.getPrototypeOf(current);
		}
	} catch {
		// Provider model objects may be proxies. Telemetry must fail closed.
	}
	return;
}
