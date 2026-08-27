import {
  nullableStringBinding,
  numberBinding,
  stringBinding,
} from "./bindings";
import type { InMemoryDurableObjectSqlState } from "./state";

export function writeScheduledWorkStatement(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): boolean {
  if (query.startsWith("insert into pss_scheduled_work")) {
    insertScheduledWork(state, bindings);
    return true;
  }
  if (query.startsWith("update pss_scheduled_work set claim_token = null")) {
    releaseScheduledWork(state, bindings);
    return true;
  }
  if (query.startsWith("update pss_scheduled_work set claim_token")) {
    claimScheduledWork(state, bindings);
    return true;
  }
  if (query.startsWith("delete from pss_scheduled_work")) {
    deleteScheduledWork(state, query, bindings);
    return true;
  }
  return false;
}

function insertScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const hasDueAt = bindings.length > 7;
  const prefix = stringBinding(bindings[0]);
  const kind = stringBinding(bindings[1]);
  const workId = stringBinding(bindings[2]);
  state.scheduledWork = state.scheduledWork.filter(
    (row) =>
      !(row.prefix === prefix && row.kind === kind && row.work_id === workId)
  );
  state.scheduledWork.push({
    claimed_until: null,
    claim_token: null,
    created_at: numberBinding(bindings[hasDueAt ? 7 : 6]),
    due_at:
      hasDueAt && bindings[6] !== null ? numberBinding(bindings[6]) : null,
    kind,
    payload: stringBinding(bindings[3]),
    prefix,
    run_id: nullableStringBinding(bindings[5]),
    thread_key: nullableStringBinding(bindings[4]),
    work_id: workId,
  });
}

function claimScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const token = stringBinding(bindings[0]);
  const claimedUntil = numberBinding(bindings[1]);
  const dueAt = numberBinding(bindings[2]);
  const prefix = stringBinding(bindings[3]);
  const kind = stringBinding(bindings[4]);
  const workId = stringBinding(bindings[5]);
  const nowMs = numberBinding(bindings[6]);
  const row = state.scheduledWork.find(
    (candidate) =>
      candidate.prefix === prefix &&
      candidate.kind === kind &&
      candidate.work_id === workId &&
      (candidate.claimed_until === null || candidate.claimed_until <= nowMs)
  );
  if (row !== undefined) {
    row.claim_token = token;
    row.claimed_until = claimedUntil;
    row.due_at = dueAt;
  }
}

function releaseScheduledWork(
  state: InMemoryDurableObjectSqlState,
  bindings: readonly unknown[]
): void {
  const payload = stringBinding(bindings[0]);
  const dueAt = numberBinding(bindings[1]);
  const createdAt = numberBinding(bindings[2]);
  const prefix = stringBinding(bindings[3]);
  const kind = stringBinding(bindings[4]);
  const workId = stringBinding(bindings[5]);
  const token = stringBinding(bindings[6]);
  const row = state.scheduledWork.find(
    (candidate) =>
      candidate.prefix === prefix &&
      candidate.kind === kind &&
      candidate.work_id === workId &&
      candidate.claim_token === token
  );
  if (row !== undefined) {
    row.claim_token = null;
    row.claimed_until = null;
    row.created_at = createdAt;
    row.due_at = dueAt;
    row.payload = payload;
  }
}

function deleteScheduledWork(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[]
): void {
  const prefix = stringBinding(bindings[0]);
  if (deleteIndexedRows(state, query, bindings, prefix)) {
    return;
  }
  const kind = stringBinding(bindings[1]);
  const workId = stringBinding(bindings[2]);
  const token =
    query.includes("claim_token = ?") && bindings.length > 3
      ? stringBinding(bindings[3])
      : undefined;
  state.scheduledWork = state.scheduledWork.filter(
    (row) =>
      !(
        row.prefix === prefix &&
        row.kind === kind &&
        row.work_id === workId &&
        (token === undefined || row.claim_token === token)
      )
  );
}

function deleteIndexedRows(
  state: InMemoryDurableObjectSqlState,
  query: string,
  bindings: readonly unknown[],
  prefix: string
): boolean {
  const selectors = [
    {
      marker: "payload like ?",
      matches: (row: { readonly payload: string }, value: string) =>
        sqliteLikeMatches(row.payload, value),
    },
    {
      marker: "thread_key = ?",
      matches: (row: { readonly thread_key: string | null }, value: string) =>
        row.thread_key === value,
    },
    {
      marker: "run_id = ?",
      matches: (row: { readonly run_id: string | null }, value: string) =>
        row.run_id === value,
    },
  ];
  const selector = selectors.find((candidate) =>
    query.includes(candidate.marker)
  );
  if (selector === undefined) {
    return false;
  }
  const value = stringBinding(bindings[1]);
  state.scheduledWork = state.scheduledWork.filter(
    (row) => !(row.prefix === prefix && selector.matches(row, value))
  );
  return true;
}

function sqliteLikeMatches(value: string, pattern: string): boolean {
  let source = "^";
  let escaping = false;
  for (const char of pattern) {
    if (escaping) {
      source += escapeRegExp(char);
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (char === "%") {
      source += ".*";
    } else if (char === "_") {
      source += ".";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}${escaping ? "\\\\" : ""}$`, "s").test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
