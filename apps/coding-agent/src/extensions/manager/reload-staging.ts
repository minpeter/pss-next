import { Worker } from "node:worker_threads";
import type { ImportExtensionModule } from "./types";

/**
 * Reload staging (#262): before `/reload` re-imports replacement extensions
 * into the live process, every candidate module graph is evaluated in a
 * separate worker-thread module context. Only when the staged graph loads
 * cleanly does the reload proceed to the main-context import and swap, so a
 * candidate that throws at module scope (or exports the wrong shape) can
 * never leave superseded module instances, half-populated CommonJS caches,
 * or side effects behind in the runtime that keeps running after the failed
 * reload.
 *
 * The staging importer returns a stub namespace that mirrors the shape the
 * worker observed (factory / extension object / invalid), which is enough
 * for the loader's validation to pass or fail exactly like the later
 * main-context import would. Module side effects run once in the discarded
 * worker context and once more at commit time; staging trades that repeat
 * execution for keeping the live module graph untouched on failure.
 */
export interface ExtensionStagingSession {
  /** Terminates the staging worker. Safe to call multiple times. */
  dispose(): Promise<void>;
  /** Imports a specifier in the staging worker and returns a stub. */
  readonly importer: ImportExtensionModule;
}

interface StagingResponse {
  readonly id?: string;
  readonly message?: string;
  readonly ok: boolean;
  readonly requestId: number;
  readonly shape?: "extension" | "factory" | "invalid";
}

const STAGING_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ requestId, specifier }) => {
  import(specifier).then((namespace) => {
    const candidate =
      namespace !== null && typeof namespace === "object" && "default" in namespace
        ? namespace.default
        : namespace;
    if (typeof candidate === "function") {
      parentPort.postMessage({ ok: true, requestId, shape: "factory" });
      return;
    }
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof candidate.id === "string" &&
      typeof candidate.configure === "function"
    ) {
      parentPort.postMessage({
        id: candidate.id,
        ok: true,
        requestId,
        shape: "extension",
      });
      return;
    }
    parentPort.postMessage({ ok: true, requestId, shape: "invalid" });
  }, (error) => {
    parentPort.postMessage({
      message:
        error instanceof Error ? (error.message ?? String(error)) : String(error),
      ok: false,
      requestId,
    });
  });
});
`;

export function beginExtensionStagingSession(): ExtensionStagingSession {
  const worker = new Worker(STAGING_WORKER_SOURCE, { eval: true });
  // A leaked idle session must never keep the process alive on its own,
  // but in-flight staged imports must: `syncRef` refs the worker while
  // requests are pending and unrefs it when the session goes idle.
  worker.unref();
  const pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (response: StagingResponse) => void;
    }
  >();
  let nextRequestId = 0;
  let terminated = false;

  const syncRef = (): void => {
    if (terminated) {
      return;
    }
    if (pending.size > 0) {
      worker.ref();
    } else {
      worker.unref();
    }
  };

  const failAllPending = (error: Error): void => {
    for (const [, entry] of pending) {
      entry.reject(error);
    }
    pending.clear();
  };

  worker.on("message", (response: StagingResponse) => {
    const entry = pending.get(response.requestId);
    if (entry === undefined) {
      return;
    }
    pending.delete(response.requestId);
    syncRef();
    entry.resolve(response);
  });
  worker.on("error", (error: unknown) => {
    terminated = true;
    failAllPending(
      new Error(
        `Extension staging worker failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    );
  });
  worker.on("exit", () => {
    terminated = true;
    failAllPending(new Error("Extension staging worker exited"));
  });

  const importer: ImportExtensionModule = async (specifier) => {
    if (terminated) {
      throw new Error("Extension staging session is disposed");
    }
    const requestId = nextRequestId;
    nextRequestId += 1;
    const response = await new Promise<StagingResponse>((resolve, reject) => {
      pending.set(requestId, { reject, resolve });
      syncRef();
      worker.postMessage({ requestId, specifier });
    });
    if (!response.ok) {
      throw new Error(
        `Staged extension import failed for ${specifier}: ${response.message ?? "unknown error"}`
      );
    }
    return stubNamespace(response);
  };

  return {
    dispose: async () => {
      terminated = true;
      failAllPending(new Error("Extension staging session is disposed"));
      await worker.terminate();
    },
    importer,
  };
}

function stubNamespace(response: StagingResponse): Record<string, unknown> {
  switch (response.shape) {
    case "factory":
      return { default: () => undefined };
    case "extension":
      return {
        default: {
          configure: () => undefined,
          id: response.id ?? "",
        },
      };
    default:
      // Mirrors an invalid export so the loader raises the same error the
      // main-context import would, still without touching the live graph.
      return { default: undefined };
  }
}
