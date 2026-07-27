export type DataRecord = Readonly<Record<string, unknown>>;

export function snapshotDataRecord(value: unknown, label: string): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new TypeError(`${label} contains unsupported symbol property`);
    }
    const descriptor = Reflect.get(descriptors, key) as
      | PropertyDescriptor
      | undefined;
    if (descriptor && !("value" in descriptor)) {
      throw new TypeError(`${label} must contain only data properties`);
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.value,
      ])
    )
  );
}

export function assertKeys(
  value: DataRecord,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${label} contains unsupported property "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing property "${key}"`);
    }
  }
}

export function snapshotOptionalStringArray(
  value: unknown,
  label: string
): string[] {
  return value === undefined ? [] : snapshotStringArray(value, label);
}

export function snapshotStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!(descriptor && "value" in descriptor)) {
      throw new TypeError(`${label} must contain only data properties`);
    }
  }
  return Array.from({ length: value.length }, (_, index) =>
    requiredString(descriptors[index]?.value, label)
  );
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}
