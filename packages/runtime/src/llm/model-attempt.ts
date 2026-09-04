import { APICallError } from "ai";
import type {
	ModelAttempt,
	TurnErrorMetadataV1,
} from "../thread/protocol/events";
import {
	normalizeApiCallError,
	PROVIDER_METADATA_FAILED,
} from "../thread/runtime/turn-error-provider-metadata";
import { safeTelemetryIdentifier } from "./model-usage";

/** Provider call identity reported by the AI SDK for one attempt. */
export interface ModelAttemptOrigin {
	readonly modelId?: string;
	readonly provider?: string;
}

export interface ModelAttemptTracker {
	readonly attempts: number;
	/**
	 * Records a provider call start. A still-open previous attempt means the
	 * SDK retried it, so its failure event is returned alongside the new start.
	 */
	begin(origin?: ModelAttemptOrigin): readonly ModelAttempt[];
	/** Resolves the newest unresolved attempt as failed, if one is open. */
	fail(error: unknown): ModelAttempt | undefined;
	/**
	 * Records a provider error the SDK reported but swallowed by retrying, so
	 * the retried attempt's failure event can still carry its category.
	 */
	observeFailure(error: unknown): void;
	/** Resolves the newest unresolved attempt as succeeded, if one is open. */
	succeed(origin?: ModelAttemptOrigin): ModelAttempt | undefined;
}

/**
 * Tracks provider call attempts for one runtime model step.
 *
 * The AI SDK invokes `onLanguageModelCallStart` inside its retry closure, so
 * every physical request — including retries — opens an attempt here. Success
 * arrives through `onLanguageModelCallEnd`, which the SDK only notifies for a
 * stream that finished, so a still-open attempt at step failure is the retried
 * or terminal request and is closed by `fail`.
 */
export function createModelAttemptTracker({
	attemptId,
	now = () => Date.now(),
}: {
	readonly attemptId: string;
	readonly now?: () => number;
}): ModelAttemptTracker {
	let attempts = 0;
	let open:
		| { readonly attempt: number; readonly startedAt: number }
		| undefined;
	let observedFailure: TurnErrorMetadataV1 | undefined;

	const identity = (origin?: ModelAttemptOrigin) => {
		const modelId = safeTelemetryIdentifier(origin?.modelId);
		const provider = safeTelemetryIdentifier(origin?.provider);
		return {
			...(modelId === undefined ? {} : { modelId }),
			...(provider === undefined ? {} : { provider }),
		};
	};

	const closeOpen = ():
		| {
			attempt: number;
			durationMs?: number;
			retryReason?: TurnErrorMetadataV1;
		}
		| undefined => {
		if (!open) {
			return undefined;
		}
		const elapsed = now() - open.startedAt;
		const attempt = open.attempt;
		const retryReason = observedFailure;
		open = undefined;
		observedFailure = undefined;
		return {
			attempt,
			...(Number.isFinite(elapsed) && elapsed >= 0
				? { durationMs: Math.round(elapsed) }
				: {}),
			...(retryReason === undefined ? {} : { retryReason }),
		};
	};

	return {
		get attempts() {
			return attempts;
		},

		begin(origin) {
			const retried = closeOpen();
			attempts += 1;
			open = { attempt: attempts, startedAt: now() };
			const start = {
				attempt: attempts,
				attemptId,
				...identity(origin),
				phase: "start",
				type: "model-attempt",
			} as const satisfies ModelAttempt;
			return retried === undefined
				? [start]
				: [retriedFailureEvent(attemptId, retried), start];
		},

		fail(error) {
			const closed = closeOpen();
			if (!closed) {
				return undefined;
			}
			const metadata = normalizeAttemptError(error) ?? closed.retryReason;
			return {
				attempt: closed.attempt,
				attemptId,
				...(closed.durationMs === undefined
					? {}
					: { durationMs: closed.durationMs }),
				...(metadata === undefined ? {} : { error: metadata }),
				outcome: "failed",
				phase: "end",
				type: "model-attempt",
			};
		},

		observeFailure(error) {
			observedFailure ??= normalizeAttemptError(error);
		},

		succeed(origin) {
			const closed = closeOpen();
			if (!closed) {
				return undefined;
			}
			return {
				attempt: closed.attempt,
				attemptId,
				...(closed.durationMs === undefined
					? {}
					: { durationMs: closed.durationMs }),
				...identity(origin),
				outcome: "succeeded",
				phase: "end",
				type: "model-attempt",
			};
		},
	};
}

function retriedFailureEvent(
	attemptId: string,
	closed: {
		readonly attempt: number;
		readonly durationMs?: number;
		readonly retryReason?: TurnErrorMetadataV1;
	},
): ModelAttempt {
	return {
		attempt: closed.attempt,
		attemptId,
		...(closed.durationMs === undefined
			? {}
			: { durationMs: closed.durationMs }),
		...(closed.retryReason === undefined
			? {}
			: { error: closed.retryReason }),
		outcome: "failed",
		phase: "end",
		type: "model-attempt",
	};
}

/**
 * Classifies an attempt failure with the same hardened normalization the turn
 * error path uses, so attempt events and `turn-error` agree on the category.
 */
function normalizeAttemptError(
	error: unknown,
): TurnErrorMetadataV1 | undefined {
	const apiCallError = firstApiCallError(error);
	if (!apiCallError) {
		return undefined;
	}
	const metadata = normalizeApiCallError(apiCallError);
	return metadata === PROVIDER_METADATA_FAILED ? undefined : metadata;
}

const MAX_ERROR_DEPTH = 8;

function firstApiCallError(error: unknown): APICallError | undefined {
	let node = error;
	for (let depth = 0; depth < MAX_ERROR_DEPTH; depth += 1) {
		if (APICallError.isInstance(node)) {
			return node;
		}
		if (typeof node !== "object" || node === null) {
			return undefined;
		}
		const nested = readErrors(node) ?? readCause(node);
		if (nested === undefined) {
			return undefined;
		}
		node = nested;
	}
	return undefined;
}

function readErrors(node: object): unknown {
	try {
		const errors: unknown = Reflect.get(node, "errors");
		return Array.isArray(errors) && errors.length > 0
			? errors.at(-1)
			: undefined;
	} catch {
		return undefined;
	}
}

function readCause(node: object): unknown {
	try {
		return Reflect.get(node, "cause");
	} catch {
		return undefined;
	}
}
