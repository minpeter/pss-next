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
    const record = right as Record<string, unknown>;
    return (
      keys.length === Object.keys(record).length &&
      keys.every(
        (key) =>
          Object.hasOwn(record, key) &&
          equalSnapshot((left as Record<string, unknown>)[key], record[key])
      )
    );
  }
  return false;
}
