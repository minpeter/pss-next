import { AsyncLocalStorage } from "node:async_hooks";

interface BusyEntry {
  base: string;
  message: string;
  suspended: number;
}

/** Operation lifetimes own visibility; streaming events only change labels. */
export class BusyStatus {
  private readonly context = new AsyncLocalStorage<readonly BusyEntry[]>();
  private readonly entries = new Set<BusyEntry>();
  private disposed = false;

  private readonly render: (message: string | null) => void;

  constructor(render: (message: string | null) => void) {
    this.render = render;
  }

  private publish(): void {
    if (this.disposed) {
      return;
    }
    const visible = [...this.entries].filter((entry) => entry.suspended === 0);
    this.render(visible.at(-1)?.message ?? null);
  }

  async run<T>(message: string, operation: () => T | Promise<T>): Promise<T> {
    const entry = { base: message, message, suspended: 0 };
    if (!this.disposed) {
      this.entries.add(entry);
    }
    this.publish();
    try {
      return await this.context.run(
        [...(this.context.getStore() ?? []), entry],
        operation
      );
    } finally {
      this.entries.delete(entry);
      this.publish();
    }
  }

  /** An extension status is an independent lease, not a global clear switch. */
  status(message: string): () => void {
    const entry = { base: message, message, suspended: 0 };
    if (!this.disposed) {
      this.entries.add(entry);
    }
    this.publish();
    return () => {
      this.entries.delete(entry);
      this.publish();
    };
  }

  setMessage(message: string | null): void {
    const entry = this.context.getStore()?.at(-1);
    if (entry && this.entries.has(entry)) {
      entry.message = message ?? entry.base;
      this.publish();
    }
  }

  getMessage(): string | undefined {
    return this.context.getStore()?.at(-1)?.message;
  }

  /** Suspend only the calling operation chain, never independent background work. */
  suspend(): () => void {
    const entries = this.context.getStore() ?? [];
    for (const entry of entries) {
      entry.suspended += 1;
    }
    this.publish();
    let resumed = false;
    return () => {
      if (resumed) {
        return;
      }
      resumed = true;
      for (const entry of entries) {
        entry.suspended -= 1;
      }
      this.publish();
    };
  }

  dispose(): void {
    this.entries.clear();
    this.render(null);
    this.disposed = true;
    // Keep async context available for detached callbacks, which must remain
    // inert rather than acquiring a fresh owner after terminal teardown.
  }
}
