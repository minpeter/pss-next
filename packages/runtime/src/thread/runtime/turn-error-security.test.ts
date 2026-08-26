import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import { createRuntimeInputState } from "../input/runtime-input";
import { BufferedAgentTurn } from "../protocol/turn";
import { ThreadState } from "../state/thread-state";
import { emitTurnErrorAfterRecovery } from "./turn-error";
import { normalizeTurnError } from "./turn-error-metadata";
import { boundedMetadataString } from "./turn-error-provider-metadata";

const API_CALL_ERROR_MARKER = Symbol.for("vercel.ai.error.AI_APICallError");
const SAFE_UNKNOWN = {
  error: { category: "unknown", version: 1 },
  message: "The request failed.",
} as const;

const apiErrorLike = (): Record<PropertyKey, unknown> => ({
  [API_CALL_ERROR_MARKER]: true,
  cause: undefined,
  data: undefined,
  isRetryable: false,
  responseHeaders: undefined,
  statusCode: 500,
});

describe("turn error security boundaries", () => {
  it("persists and emits stable prose when an ordinary Error contains secrets and terminal controls", async () => {
    const persisted: unknown[] = [];
    const run = new BufferedAgentTurn();
    const iterator = run.events()[Symbol.asyncIterator]();
    const emitted = iterator.next();

    await emitTurnErrorAfterRecovery({
      error: new Error("secret-token\u001b[2J\u202Ehidden"),
      historySnapshot: [],
      persistEvent: (event) => {
        persisted.push(event);
        return Promise.resolve();
      },
      run,
      runtimeInput: createRuntimeInputState([]),
      state: new ThreadState({
        key: "turn-error-security",
        store: new MemoryThreadStore(),
      }),
    });

    const expected = {
      error: { category: "unknown", version: 1 },
      message: "The request failed.",
      type: "turn-error",
    };
    expect(persisted).toEqual([expected]);
    expect((await emitted).value).toEqual(expected);
    await iterator.return?.();
  });

  it("fails closed when an SDK marker trap throws", () => {
    const hostileMarker = new Proxy(
      {},
      {
        has() {
          throw new Error("hostile marker");
        },
      }
    );

    expect(normalizeTurnError(hostileMarker)).toEqual(SAFE_UNKNOWN);
  });

  it.each(["data", "statusCode", "responseHeaders", "isRetryable"] as const)(
    "fails closed when the API %s accessor throws",
    (field) => {
      const hostileError = Object.defineProperty(apiErrorLike(), field, {
        get() {
          throw new Error(`hostile ${field}`);
        },
      });

      expect(normalizeTurnError(hostileError)).toEqual(SAFE_UNKNOWN);
    }
  );

  it("fails closed when response headers have a hostile prototype", () => {
    const hostilePrototype = Object.defineProperty({}, "retry-after-ms", {
      enumerable: true,
      get() {
        throw new Error("hostile header prototype");
      },
    });
    const responseHeaders: Record<string, string> = {};
    Object.setPrototypeOf(responseHeaders, hostilePrototype);
    const hostileError = { ...apiErrorLike(), responseHeaders };

    expect(normalizeTurnError(hostileError)).toEqual(SAFE_UNKNOWN);
  });

  it("reads canonical retry metadata without enumerating hostile headers", () => {
    let ownKeysCount = 0;
    const target = Object.defineProperty({}, "retry-after-ms", {
      configurable: true,
      enumerable: true,
      value: "3000",
    });
    const responseHeaders = new Proxy(target, {
      ownKeys() {
        ownKeysCount += 1;
        return Array.from(
          { length: 100_000 },
          (_, index) => `hostile-${index}`
        );
      },
    });

    expect(
      normalizeTurnError({
        ...apiErrorLike(),
        responseHeaders,
        statusCode: 429,
      })
    ).toEqual({
      error: {
        category: "rate-limit",
        observedRetryable: false,
        retryAfterMs: 3000,
        status: 429,
        version: 1,
      },
      message: "The provider rate limit was reached.",
    });
    expect(ownKeysCount).toBe(0);
  });

  it("fails closed when a response header getter throws", () => {
    const responseHeaders = Object.defineProperty({}, "retry-after-ms", {
      enumerable: true,
      get() {
        throw new Error("hostile header getter");
      },
    });

    expect(normalizeTurnError({ ...apiErrorLike(), responseHeaders })).toEqual(
      SAFE_UNKNOWN
    );
  });

  it("fails closed when aggregate array length access throws", () => {
    const aggregate = new AggregateError([], "hostile aggregate");
    Object.defineProperty(aggregate, "errors", {
      value: new Proxy([], {
        get(target, property, receiver) {
          if (property === "length") {
            throw new Error("hostile aggregate length");
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });

    expect(normalizeTurnError(aggregate)).toEqual(SAFE_UNKNOWN);
  });

  it("stops reading headers after finding the preferred retry delay", () => {
    let getterCount = 0;
    const responseHeaders: Record<string, string> = {};
    Object.defineProperty(responseHeaders, "retry-after-ms", {
      enumerable: true,
      get() {
        getterCount += 1;
        return "3000";
      },
    });
    for (let index = 0; index < 100; index += 1) {
      Object.defineProperty(responseHeaders, `x-unused-${index}`, {
        enumerable: true,
        get() {
          getterCount += 1;
          return "unused";
        },
      });
    }

    expect(
      normalizeTurnError({ ...apiErrorLike(), responseHeaders }).error
        ?.retryAfterMs
    ).toBe(3000);
    expect(getterCount).toBe(1);
  });

  it.each(["86400001", "1.5", "9007199254740991"])(
    "rejects unsafe retry-after-ms value %s",
    (retryAfterMs) => {
      const normalized = normalizeTurnError({
        ...apiErrorLike(),
        responseHeaders: { "retry-after-ms": retryAfterMs },
      });

      expect(normalized.error?.retryAfterMs).toBeUndefined();
    }
  );

  it("omits raw provider codes, types, and correlation identifiers", () => {
    const normalized = normalizeTurnError({
      ...apiErrorLike(),
      data: {
        error: {
          code: "secret-provider-code",
          type: "secret-provider-type",
        },
      },
      responseHeaders: {
        "x-request-id": "secret-correlation-id",
      },
      statusCode: 403,
    });

    expect(normalized).toEqual({
      error: {
        category: "permission",
        observedRetryable: false,
        status: 403,
        version: 1,
      },
      message: "The provider refused this request.",
    });
  });

  it("removes terminal-active Unicode and bounds work before truncation", () => {
    expect(
      boundedMetadataString("\u202E\u2066\u2028\u2029safe\u001b[2J", 32)
    ).toBe("safe[2J");
    expect(
      boundedMetadataString(`${"\u202E".repeat(10_000)}unreachable`, 32)
    ).toBeUndefined();
  });
});
