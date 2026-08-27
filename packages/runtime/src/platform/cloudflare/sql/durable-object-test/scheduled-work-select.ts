import { numberBinding, stringBinding } from "./bindings";
import type { InMemoryDurableObjectSqlState, ScheduledWorkRow } from "./state";

export function isScheduledWorkQuery(query: string): boolean {
  return (
    query.startsWith("select ") && query.includes("from pss_scheduled_work")
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
    { name: "due_at" },
    { name: "claim_token" },
    { name: "claimed_until" },
  ];
}

export function selectScheduledWorkRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): unknown[] {
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = query.includes("work_id = ?")
    ? stringBinding(bindings[2])
    : undefined;
  const claimToken = query.includes("claim_token = ?")
    ? stringBinding(bindings[3])
    : undefined;
  const dueBefore = query.includes("due_at <= ?")
    ? numberBinding(bindings[2])
    : undefined;
  const limit = selectedLimit(query, bindings, {
    dueBefore,
    workId,
  });
  const offset = query.includes("offset ?")
    ? numberBinding(bindings[workId === undefined ? 3 : 4])
    : 0;
  return state.scheduledWork
    .filter(
      (row) =>
        row.prefix === prefix &&
        row.kind === kind &&
        (workId === undefined || row.work_id === workId) &&
        (claimToken === undefined || row.claim_token === claimToken) &&
        (dueBefore === undefined ||
          (row.due_at !== null && row.due_at <= dueBefore)) &&
        (!query.includes("due_at is not null") || row.due_at !== null)
    )
    .sort((left, right) => compareRows(left, right, query))
    .slice(offset, limit === undefined ? undefined : offset + limit)
    .map((row) => projectRow(row, query));
}

function selectedLimit(
  query: string,
  bindings: readonly unknown[],
  options: {
    readonly dueBefore: number | undefined;
    readonly workId: string | undefined;
  }
): number | undefined {
  if (query.includes("limit 1")) {
    return 1;
  }
  if (!query.includes("limit ?")) {
    return;
  }
  if (options.dueBefore !== undefined) {
    return numberBinding(bindings[3]);
  }
  return numberBinding(bindings[options.workId === undefined ? 2 : 3]);
}

function compareRows(
  left: ScheduledWorkRow,
  right: ScheduledWorkRow,
  query: string
): number {
  if (query.includes("order by due_at")) {
    return (
      (left.due_at ?? Number.MAX_SAFE_INTEGER) -
      (right.due_at ?? Number.MAX_SAFE_INTEGER)
    );
  }
  return left.created_at - right.created_at;
}

function projectRow(row: ScheduledWorkRow, query: string): unknown {
  if (query.startsWith("select work_id from")) {
    return { work_id: row.work_id };
  }
  if (query.startsWith("select claim_token from")) {
    return { claim_token: row.claim_token };
  }
  if (query.startsWith("select due_at from")) {
    return { due_at: row.due_at };
  }
  return {
    claimed_until: row.claimed_until,
    claim_token: row.claim_token,
    due_at: row.due_at,
    payload: row.payload,
    run_id: row.run_id,
    thread_key: row.thread_key,
    work_id: row.work_id,
  };
}
