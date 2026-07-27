/**
 * A promise with externally controlled settlement.
 *
 * Used by the lifecycle state machines to store a promise inside a state
 * before the async work that settles it is wired up, so the transition
 * order never depends on microtask scheduling.
 */
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}
