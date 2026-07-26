import {
  assertKeys,
  requiredString,
  snapshotDataRecord,
  snapshotStringArray,
} from "./data-validation";
import type { CodingAgentExtensionModelProvider } from "./types";

const MODEL_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function snapshotModelProvider(
  value: unknown
): CodingAgentExtensionModelProvider {
  const provider = snapshotDataRecord(value, "Extension model provider");
  assertKeys(provider, ["create", "id", "models"], "Extension model provider");
  const id = requiredString(provider.id, "Extension model provider id");
  if (
    id.trim() !== id ||
    !MODEL_PROVIDER_ID_PATTERN.test(id) ||
    id === "__proto__" ||
    id === "constructor" ||
    id === "prototype"
  ) {
    throw new TypeError(`Invalid extension model provider id "${id}"`);
  }
  const models = snapshotStringArray(
    provider.models,
    `Extension model provider "${id}" models`
  );
  if (models.length === 0) {
    throw new TypeError(
      `Extension model provider "${id}" must provide at least one model`
    );
  }
  const seen = new Set<string>();
  for (const model of models) {
    if (
      model.trim() !== model ||
      !MODEL_ID_PATTERN.test(model) ||
      seen.has(model)
    ) {
      throw new TypeError(
        `Invalid or duplicate extension model "${model}" for provider "${id}"`
      );
    }
    seen.add(model);
  }
  if (typeof provider.create !== "function") {
    throw new TypeError(
      `Extension model provider "${id}" create must be a function`
    );
  }
  return Object.freeze({
    create: provider.create as CodingAgentExtensionModelProvider["create"],
    id,
    models: Object.freeze([...models]),
  });
}
