import { Worker } from "node:worker_threads";

const RENDER_TIMEOUT_MS = 5000;

interface WorkerReply {
  readonly art?: readonly string[];
  readonly id: number;
}

interface PendingRender {
  readonly reject: (error: Error) => void;
}

let worker: Worker | undefined;
let pending: PendingRender | undefined;
let nextRequestId = 1;
let renderTail = Promise.resolve();

const workerUrl = (): URL => {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./mermaid-art-worker.${extension}`, import.meta.url);
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
        new Error(`Mermaid art worker exited unexpectedly (${code})`)
      );
    }
  });
  return instance;
};

const dispatchRender = (
  source: string,
  signal?: AbortSignal
): Promise<readonly string[] | undefined> => {
  signal?.throwIfAborted();
  const instance = getWorker();
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
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
      finish(() => resolve(reply.art));
    };
    const timeout = setTimeout(() => {
      terminateWorker(instance, new Error("Mermaid art render timed out"));
    }, RENDER_TIMEOUT_MS);
    pending = { reject: (error) => finish(() => reject(error)) };
    instance.on("message", message);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    instance.postMessage({ id, source });
  });
};

/** Render diagram source to box-art lines in a bounded worker, if possible. */
export const renderMermaidArt = (
  source: string,
  signal?: AbortSignal
): Promise<readonly string[] | undefined> => {
  const result = renderTail.then(() => dispatchRender(source, signal));
  renderTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
};
