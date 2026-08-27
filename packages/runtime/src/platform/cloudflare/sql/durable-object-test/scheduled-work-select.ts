import { numberBinding, stringBinding } from "./bindings";
import type { InMemoryDurableObjectSqlState, ScheduledWorkRow } from "./state";

export function isScheduledWorkOffsetQuery(query: string): boolean {
  return (
    query.includes("from pss_scheduled_work") && query.includes("offset ?")
  );
}

export function scheduledWorkTableInfoRows(): unknown[] {
  return [
    { name: "prefix" },
    { name: "kind" },
    { name: "work_id" },
    { name: "payload" },
    { name: "thread_key" },
    { name: "run_id" },
    { name: "created_at" },
    { name: "claim_token" },
    { name: "claimed_until" },
  ];
}

export function selectScheduledWorkRowsWithOffset(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = query.includes("work_id = ?")
    ? stringBinding(bindings[2])
    : undefined;
  const limit = numberBinding(bindings[workId === undefined ? 2 : 3]);
  const offset = numberBinding(bindings[workId === undefined ? 3 : 4]);
  return state.scheduledWork
    .filter(
      (row) =>
        row.prefix === prefix &&
        row.kind === kind &&
        (workId === undefined || row.work_id === workId)
    )
    .sort(
      (left: ScheduledWorkRow, right: ScheduledWorkRow) =>
        left.created_at - right.created_at
    )
    .slice(offset, offset + limit)
    .map((row) => ({
      claimed_until: row.claimed_until,
      claim_token: row.claim_token,
      payload: row.payload,
      run_id: row.run_id,
      thread_key: row.thread_key,
      work_id: row.work_id,
    }));
}
