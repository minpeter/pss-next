import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import type { InMemoryDurableObjectSqlState, NotificationRow } from "./state";

export function writeNotificationStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): boolean {
  if (query.startsWith("insert into pss_notification")) {
    upsertNotification(state, bindings);
    return true;
  }
  if (query.startsWith("delete from pss_notification")) {
    const prefix = stringBinding(bindings[0]);
    const threadKey = stringBinding(bindings[1]);
    state.notifications = state.notifications.filter(
      (row) => !(row.prefix === prefix && row.thread_key === threadKey)
    );
    return true;
  }
  return false;
}

function upsertNotification(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const row = createNotificationRow(bindings);
  state.notifications = state.notifications.filter(
    (existing) =>
      !(
        existing.prefix === row.prefix &&
        existing.idempotency_key === row.idempotency_key
      )
  );
  state.notifications.push(row);
}

function createNotificationRow(bindings: readonly unknown[]): NotificationRow {
  return {
    created_at: numberBinding(bindings[8]),
    idempotency_key: stringBinding(bindings[1]),
    notification_id: stringBinding(bindings[3]),
    owner_namespace: nullableStringBinding(bindings[6]),
    prefix: stringBinding(bindings[0]),
    record: stringBinding(bindings[2]),
    run_id: stringBinding(bindings[4]),
    status: stringBinding(bindings[7]),
    thread_key: stringBinding(bindings[5]),
    updated_at: numberBinding(bindings[9]),
  };
}
