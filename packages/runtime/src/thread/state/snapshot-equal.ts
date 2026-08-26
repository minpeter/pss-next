function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export function equalSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) &&
    (right instanceof ArrayBuffer || ArrayBuffer.isView(right))
  ) {
    const leftBytes = bytes(left);
    const rightBytes = bytes(right);
    return (
      leftBytes.byteLength === rightBytes.byteLength &&
      leftBytes.every((value, index) => value === rightBytes[index])
    );
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalSnapshot(value, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    isPlainObject(left) &&
    isPlainObject(right)
  ) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) =>
          Object.hasOwn(right, key) &&
          equalSnapshot(Reflect.get(left, key), Reflect.get(right, key))
      )
    );
  }
  return false;
}

export function snapshotSuffix<T>(
  prefix: readonly T[],
  current: readonly T[]
): readonly T[] | undefined {
  if (
    current.length < prefix.length ||
    !equalSnapshot(prefix, current.slice(0, prefix.length))
  ) {
    return;
  }
  return current.slice(prefix.length);
}

export function conflictAppendSuffix<T>(
  attempted: readonly T[],
  currentLocal: readonly T[],
  remote: readonly T[]
): readonly T[] {
  if (
    snapshotSuffix(attempted, currentLocal) === undefined ||
    snapshotSuffix(attempted, remote) === undefined
  ) {
    return [];
  }
  return snapshotSuffix(remote, currentLocal) ?? [];
}
