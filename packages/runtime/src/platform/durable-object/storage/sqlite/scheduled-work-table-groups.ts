import type { SqlStorage } from "../../sql/ports/storage-port";
import type {
  DurableObjectStorage,
  DurableObjectTransactionStorage,
} from "../durable-object/durable-object-storage";
import {
  requiredSqlStorage,
  withTransaction,
} from "../durable-object/sql-access";
import type {
  ScheduledWorkKind,
  ScheduledWorkRow,
} from "./scheduled-work-table";
import { ensureScheduledWorkSchema } from "./scheduled-work-table-schema";

export interface ScheduledWorkTarget {
  readonly kind: ScheduledWorkKind;
  readonly matchesPayload?: (payload: string) => boolean;
  readonly workId: string;
}

export async function deleteScheduledWorkGroup(
  storage: DurableObjectStorage,
  prefix: string,
  targets: readonly ScheduledWorkTarget[]
): Promise<boolean> {
  return await withTransaction(storage, (transaction) => {
    const sql = requiredGroupSql(transaction);
    ensureScheduledWorkSchema(sql);
    let deleted = false;
    for (const target of targets) {
      for (const row of matchingRows(sql, prefix, target)) {
        sql.exec(
          "DELETE FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
          prefix,
          target.kind,
          row.work_id
        );
        deleted = true;
      }
    }
    return Promise.resolve(deleted);
  });
}

export function hasScheduledWorkGroup(
  storage: DurableObjectStorage,
  prefix: string,
  targets: readonly ScheduledWorkTarget[]
): boolean {
  const sql = requiredGroupSql(storage);
  ensureScheduledWorkSchema(sql);
  return targets.some((target) => matchingRows(sql, prefix, target).length > 0);
}

function matchingRows(
  sql: SqlStorage,
  prefix: string,
  target: ScheduledWorkTarget
): ScheduledWorkRow[] {
  const rows = sql
    .exec<ScheduledWorkRow>(
      "SELECT work_id, payload FROM pss_scheduled_work WHERE prefix = ? AND kind = ? AND work_id = ?",
      prefix,
      target.kind,
      target.workId
    )
    .toArray();
  return target.matchesPayload === undefined
    ? rows
    : rows.filter((row) => target.matchesPayload?.(row.payload));
}

function requiredGroupSql(
  storage: DurableObjectTransactionStorage
): SqlStorage {
  return requiredSqlStorage(storage, "Durable Object scheduled work group");
}
