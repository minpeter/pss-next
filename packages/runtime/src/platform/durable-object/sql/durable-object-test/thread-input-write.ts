import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import type { InMemoryDurableObjectSqlState, ThreadInputRow } from "./state";

export function deleteThreadInputs(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  const threadKey = stringBinding(bindings[1]);
  state.threadInputs = state.threadInputs.filter(
    (row) => !(row.prefix === prefix && row.thread_key === threadKey)
  );
}

export function upsertThreadInput(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const existing = state.threadInputs.find(
    (row) =>
      row.prefix === stringBinding(bindings[0]) &&
      row.thread_key === stringBinding(bindings[1]) &&
      row.message_id === stringBinding(bindings[2])
  );
  const row: ThreadInputRow = {
    admitted_at_ms: numberBinding(bindings[8]),
    admitted_seq: numberBinding(bindings[7]),
    claim_id: nullableStringBinding(bindings[9]),
    created_at: existing?.created_at ?? numberBinding(bindings[10]),
    kind: stringBinding(bindings[4]),
    message_id: stringBinding(bindings[2]),
    placement: nullableStringBinding(bindings[5]),
    prefix: stringBinding(bindings[0]),
    record: stringBinding(bindings[3]),
    status: stringBinding(bindings[6]),
    thread_key: stringBinding(bindings[1]),
    updated_at: numberBinding(bindings[11]),
  };
  state.threadInputs = state.threadInputs.filter(
    (current) =>
      !(
        current.prefix === row.prefix &&
        current.thread_key === row.thread_key &&
        current.message_id === row.message_id
      )
  );
  state.threadInputs.push(row);
}

export function updateThreadInputRecord(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[1]);
  const threadKey = stringBinding(bindings[2]);
  const messageId = stringBinding(bindings[3]);
  state.threadInputs = state.threadInputs.map((row) =>
    row.prefix === prefix &&
    row.thread_key === threadKey &&
    row.message_id === messageId
      ? { ...row, record: stringBinding(bindings[0]) }
      : row
  );
}
