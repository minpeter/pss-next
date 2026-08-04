import { grokFormat, ompFormat, ompJsonFormat } from "../formats";
import {
  createFormatMethod,
  grokMethodOptions,
  ompDslMethodOptions,
  ompJsonMethodOptions,
} from "./format-method";
import { pssMethod } from "./pss";
import type { EditMethod, EditMethodId } from "./types";

export type { EditMethod, EditMethodId, MethodToolHooks } from "./types";

export const EDIT_METHODS: readonly EditMethod[] = [
  pssMethod,
  createFormatMethod("omp-dsl", ompFormat, ompDslMethodOptions),
  createFormatMethod("omp-json", ompJsonFormat, ompJsonMethodOptions),
  createFormatMethod("grok-json", grokFormat, grokMethodOptions),
];

const byId = new Map(EDIT_METHODS.map((method) => [method.id, method]));

export const getEditMethod = (id: string): EditMethod => {
  const method = byId.get(id as EditMethodId);
  if (method === undefined) {
    throw new Error(
      `Unknown edit method: ${id}. Known: ${EDIT_METHODS.map((m) => m.id).join(", ")}`
    );
  }
  return method;
};

export const resolveEditMethods = (
  ids: readonly string[] | undefined
): readonly EditMethod[] => {
  if (ids === undefined) {
    return EDIT_METHODS;
  }
  return ids.map((id) => getEditMethod(id));
};
