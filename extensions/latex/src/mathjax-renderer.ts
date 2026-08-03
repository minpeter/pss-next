import { Worker } from "node:worker_threads";

const RENDER_TIMEOUT_MS = 10_000;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const UNSAFE_TEX_MACRO_PATTERN =
  /\\(?:class|cssId|href|htmlClass|htmlId|htmlStyle|require|style)\b/u;
const CJK_PATTERN =
  /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const KOREAN_LANGUAGE_PATTERN = /^ko/i;
const JAPANESE_LANGUAGE_PATTERN = /^ja/i;
const TRADITIONAL_CHINESE_LANGUAGE_PATTERN = /^zh[_-](?:TW|HK|MO)|Hant/i;
const CJK_LOCALES = ["ko", "ja", "zh-Hans", "zh-Hant"] as const;

export type CjkLocale = (typeof CJK_LOCALES)[number];

interface WorkerReply {
  readonly error?: string;
  readonly id: number;
  readonly png?: Uint8Array;
}

interface PendingRender {
  readonly reject: (error: Error) => void;
}

export const resolveCjkLocale = (): CjkLocale => {
  const configured = process.env.PSS_LATEX_CJK_LOCALE;
  if (CJK_LOCALES.includes(configured as CjkLocale)) {
    return configured as CjkLocale;
  }
  const language = process.env.LC_ALL ?? process.env.LANG ?? "";
  if (KOREAN_LANGUAGE_PATTERN.test(language)) {
    return "ko";
  }
  if (JAPANESE_LANGUAGE_PATTERN.test(language)) {
    return "ja";
  }
  return TRADITIONAL_CHINESE_LANGUAGE_PATTERN.test(language)
    ? "zh-Hant"
    : "zh-Hans";
};

export const formulaSupported = (formula: string): boolean =>
  !(EMOJI_PATTERN.test(formula) || UNSAFE_TEX_MACRO_PATTERN.test(formula));

export const formulaCjkLocale = (formula: string): CjkLocale | undefined =>
  CJK_PATTERN.test(formula) ? resolveCjkLocale() : undefined;

let worker: Worker | undefined;
let pending: PendingRender | undefined;
let nextRequestId = 1;
let renderTail = Promise.resolve();

const workerUrl = (): URL => {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./mathjax-worker.${extension}`, import.meta.url);
};

const terminateWorker = (instance: Worker, error: Error): void => {
  if (worker !== instance) {
    return;
  }
  worker = undefined;
  const current = pending;
  current?.reject(error);
  instance.terminate().catch(() => undefined);
};

const getWorker = (): Worker => {
  if (worker) {
    return worker;
  }
  const instance = new Worker(workerUrl(), {
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      stackSizeMb: 4,
    },
  });
  instance.unref();
  worker = instance;
  instance.on("error", (error: unknown) =>
    terminateWorker(
      instance,
      error instanceof Error ? error : new Error(String(error))
    )
  );
  instance.on("exit", (code) => {
    if (worker === instance) {
      terminateWorker(
        instance,
        new Error(`LaTeX render worker exited unexpectedly (${code})`)
      );
    }
  });
  return instance;
};

const dispatchRender = (
  formula: string,
  color: string,
  signal?: AbortSignal
): Promise<Buffer> => {
  signal?.throwIfAborted();
  const instance = getWorker();
  const id = nextRequestId++;
  return new Promise<Buffer>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (pending) {
        pending = undefined;
        instance.off("message", message);
        callback();
      }
    };
    const abort = (): void => {
      const reason = signal?.reason;
      terminateWorker(
        instance,
        reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted", "AbortError")
      );
    };
    const message = (reply: WorkerReply): void => {
      if (reply.id !== id) {
        return;
      }
      finish(() => {
        if (reply.error) {
          reject(new Error(reply.error));
        } else if (!reply.png || reply.png.byteLength > MAX_PNG_BYTES) {
          reject(
            new Error("LaTeX worker returned an invalid or oversized PNG")
          );
        } else {
          resolve(Buffer.from(reply.png));
        }
      });
    };
    const timeout = setTimeout(() => {
      terminateWorker(instance, new Error("LaTeX render worker timed out"));
    }, RENDER_TIMEOUT_MS);
    pending = { reject: (error) => finish(() => reject(error)) };
    instance.on("message", message);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    instance.postMessage({
      color,
      formula,
      id,
      locale: resolveCjkLocale(),
    });
  });
};

export const renderMathJaxPng = (
  formula: string,
  color: string,
  signal?: AbortSignal
): Promise<Buffer> => {
  if (!formulaSupported(formula)) {
    return Promise.reject(
      new Error("Formula contains unsupported text or macros")
    );
  }
  const result = renderTail.then(() => dispatchRender(formula, color, signal));
  renderTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};
