import type { ToolSet } from "ai";
import { ModelToolSelectionError } from "./model-step-error";
import { compareToolNames } from "./tool-property-descriptors";

export function snapshotToolNames(
  value: unknown,
  context: string,
  maximumLength: number
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ModelToolSelectionError(
      `${context} must be an array of tool names.`
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !(
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0 &&
      lengthDescriptor.value <= maximumLength
    )
  ) {
    throw new ModelToolSelectionError(`${context} has an invalid length.`);
  }
  const snapshot: string[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) {
      throw new ModelToolSelectionError(
        `${context} must be a dense array of data-property tool names.`
      );
    }
    if (typeof descriptor.value !== "string") {
      throw new ModelToolSelectionError(
        `${context} must contain only tool-name strings.`
      );
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

export function readonlyToolRegistry(
  registry: ToolSet | undefined
): Readonly<ToolSet> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(registry ?? {}).map(([name, definition]) => [
        name,
        readonlyToolFacade(definition),
      ])
    )
  );
}

function readonlyToolFacade(definition: ToolSet[string]): ToolSet[string] {
  const facade: Record<string, unknown> = Object.create(null);
  copyEnumerableDataProperties(definition, facade, new WeakMap());
  return Object.freeze(facade) as ToolSet[string];
}

function readonlyNestedSnapshot(
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (typeof value === "function") {
    const blocked = function readonlyToolCallback(): never {
      throw new ModelToolSelectionError(
        "prepareModelStep tool facades do not expose callable members."
      );
    };
    seen.set(value, blocked);
    copyEnumerableDataProperties(value, blocked, seen);
    return Object.freeze(blocked);
  }
  const snapshot: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : Object.create(null);
  seen.set(value, snapshot);
  copyEnumerableDataProperties(value, snapshot, seen);
  return Object.freeze(snapshot);
}

export function copyToolRegistry(
  tools: ToolSet | undefined
): ToolSet | undefined {
  if (tools === undefined) {
    return;
  }
  const registry: ToolSet = Object.create(null);
  for (const name of Object.keys(tools)) {
    const descriptor = Object.getOwnPropertyDescriptor(tools, name);
    if (!(descriptor && "value" in descriptor)) {
      throw new ModelToolSelectionError(
        `tools registry entry ${JSON.stringify(name)} must be a data property.`
      );
    }
    registry[name] = descriptor.value as ToolSet[string];
  }
  return registry;
}

function copyEnumerableDataProperties(
  source: object,
  target: object,
  seen: WeakMap<object, unknown>
): void {
  for (const key of Object.keys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!(descriptor && "value" in descriptor)) {
      continue;
    }
    const targetDescriptor = Object.getOwnPropertyDescriptor(target, key);
    if (targetDescriptor && !targetDescriptor.configurable) {
      continue;
    }
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: readonlyNestedSnapshot(descriptor.value, seen),
      writable: true,
    });
  }
}

export function canonicalToolOrder(
  registryNames: readonly string[],
  configuredOrder: readonly string[]
): string[] {
  const configured = new Set(configuredOrder);
  return [
    ...configuredOrder,
    ...registryNames
      .filter((name) => !configured.has(name))
      .sort(compareToolNames),
  ];
}

export function validateToolNames(
  names: readonly string[],
  field: string,
  registry: ReadonlySet<string>
): void {
  if (!Array.isArray(names)) {
    throw new ModelToolSelectionError(
      `${field} must be an array of tool names.`
    );
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") {
      throw new ModelToolSelectionError(`${field} must contain only strings.`);
    }
    if (seen.has(name)) {
      throw new ModelToolSelectionError(
        `${field} contains duplicate tool ${JSON.stringify(name)}.`
      );
    }
    if (!registry.has(name)) {
      throw new ModelToolSelectionError(
        `${field} references unknown tool ${JSON.stringify(name)}.`
      );
    }
    seen.add(name);
  }
}
